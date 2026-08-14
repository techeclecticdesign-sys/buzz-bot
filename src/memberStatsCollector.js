// Shared member-growth collector. Reads two channels and derives the analytics
// the rpc-web stats page charts:
//   1. Joins & leaves  — from JOINLEAVE_CHANNEL_ID (#guestbook):
//        • JOIN  = a Discord system "X joined" message (MessageType.UserJoin).
//        • LEAVE = any message authored by a bot (author.bot) — in this channel
//          a bot post is always a leave.
//      → one row per event in `member_events` (type = 'join' | 'leave').
//   2. Member-count samples — from MEMBERCOUNT_CHANNEL_ID: embeds carrying a
//      "Member Count / N" value, thinned to ~one sample per SAMPLE_SKIP_DAYS.
//      → one row per kept sample in `member_count_samples`.
//
// Every row is keyed on its source message id with ON CONFLICT, so collecting is
// idempotent: re-scanning overlapping history just no-ops. That's what lets the
// bot run this incrementally on a schedule (stop paging once we're safely past
// what's already stored) AND lets the standalone script re-scan all of history.
//
// This module is deliberately provider-agnostic about the pool/client: index.js
// passes the bot's live client + db pool for the scheduled incremental run;
// src/memberStats.js passes a throwaway client + pool for a manual full scan.
const { MessageType } = require('discord.js');

// --- Config ---------------------------------------------------------------
const JOINLEAVE_CHANNEL_ID = '404079275734466560';
const MEMBERCOUNT_CHANNEL_ID = '620143686780715018';
// After recording a member-count sample for a day, skip messages until we reach
// one at least this many days older before taking the next sample.
const SAMPLE_SKIP_DAYS = 2;
const DAY_MS = 24 * 60 * 60 * 1000;

// Incremental runs re-scan this far past the newest stored event before stopping,
// so a boundary day that gained events after the last run is never half-missed.
// The overlap is all ON CONFLICT no-ops, so it's cheap insurance.
const OVERLAP_MS = 2 * DAY_MS;

// Scheduling (only used when the bot drives this — the standalone script ignores it).
const ENABLED = process.env.MEMBER_STATS_ENABLED !== 'false';
// The stats page buckets days in UTC (memberStats.ts uses AT TIME ZONE 'UTC';
// bucket.ts's currentPeriodKey is UTC too), so a day rolls from the in-progress
// "today" to a finished bar at UTC midnight. Fire a few minutes past that so the
// just-completed day is fully in the DB the moment the chart starts showing it.
const POST_MIDNIGHT_OFFSET_MIN = Math.max(1, Number(process.env.MEMBER_STATS_MIDNIGHT_OFFSET_MIN) || 10);
const FIRST_RUN_DELAY_MS = 90_000; // boot catch-up: fill the current gap immediately

// --- Helpers --------------------------------------------------------------
// Retry transient failures (Neon wakeups, DNS blips, gateway hiccups) with
// exponential backoff; 4xx (permissions / bad request) rethrow immediately.
async function withRetry(fn, label, attempts = 6) {
  let delay = 5000;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.status ?? err.httpStatus;
      if ((status >= 400 && status < 500) || i >= attempts) throw err;
      console.warn(`  ! ${label}: ${err.message} — retrying in ${delay / 1000}s (${i}/${attempts - 1})`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 60_000);
    }
  }
}

// Start-of-day (UTC) in ms for a timestamp — the unit the day-skip works in.
function dayStartMs(ms) {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

// Pull an integer member count out of a message's embeds. Handles both the
// structured field form ({ name: 'Member Count', value: '1,234' }) and the
// "Member Count\n1,234" text form (title / description / footer). null = no match.
function parseCount(raw) {
  if (raw == null) return null;
  const m = String(raw).match(/\d{1,3}(?:,\d{3})+|\d+/);
  return m ? parseInt(m[0].replace(/,/g, ''), 10) : null;
}
function extractMemberCount(msg) {
  for (const embed of msg.embeds) {
    for (const f of embed.fields || []) {
      if (/member\s*count/i.test(f.name)) {
        const n = parseCount(f.value);
        if (n != null) return n;
      }
    }
    const blob = [embed.title, embed.description, embed.footer?.text].filter(Boolean).join('\n');
    const m = blob.match(/member\s*count[\s:]*([\d,]+)/i);
    if (m) {
      const n = parseCount(m[1]);
      if (n != null) return n;
    }
  }
  return null;
}

// The user id behind a leave post: the resolved mention first, then a snowflake
// scraped from content / any embed text (older bot formats). null when none.
function leaveUserId(msg) {
  const mentioned = msg.mentions?.users?.first();
  if (mentioned) return mentioned.id;
  const text = [
    msg.content,
    ...msg.embeds.flatMap((e) => [e.title, e.description, e.author?.name, e.footer?.text]),
  ]
    .filter(Boolean)
    .join(' ');
  const m = text.match(/<@!?(\d{17,20})>/) || text.match(/(?<!\d)(\d{17,20})(?!\d)/);
  return m ? m[1] : null;
}

// Page a channel newest→oldest, calling onMessage for each. `stopBeforeMs` ends
// the walk once a page's OLDEST message predates the cutoff — everything further
// back is already stored (incremental runs). null = walk to the beginning.
async function eachMessage(channel, onMessage, { stopBeforeMs = null, quiet = false } = {}) {
  let before;
  let scanned = 0;
  for (;;) {
    const batch = await withRetry(
      () => channel.messages.fetch({ limit: 100, before }),
      `#${channel.name}`
    );
    if (batch.size === 0) break;
    for (const msg of batch.values()) {
      await onMessage(msg);
      scanned++;
    }
    before = batch.last().id;
    if (!quiet) process.stdout.write(`  #${channel.name}: scanned ${scanned}\r`);
    if (stopBeforeMs != null && batch.last().createdTimestamp < stopBeforeMs) break;
  }
  if (!quiet) process.stdout.write(`  #${channel.name}: scanned ${scanned}\n`);
  return scanned;
}

// The cutoff (ms) an incremental walk of `table`.`col` should stop before, or
// null to force a full scan when the table is empty. Column/table are literals.
async function incrementalCutoff(pool, table, col) {
  const { rows } = await pool.query(`SELECT extract(epoch from max(${col})) AS s FROM ${table}`);
  const s = rows[0]?.s;
  return s != null ? Number(s) * 1000 - OVERLAP_MS : null;
}

// --- Schema ---------------------------------------------------------------
// Joins AND leaves share ONE table with a `type` discriminator (same shape of
// dated event; makes "events per day" a single GROUP BY). CREATE IF NOT EXISTS,
// so this is safe to call on every run.
async function initSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_events (
      message_id  TEXT PRIMARY KEY,
      type        TEXT NOT NULL CHECK (type IN ('join', 'leave')),
      occurred_at TIMESTAMPTZ NOT NULL,
      user_id     TEXT
    );
  `);
  await pool.query('ALTER TABLE member_events ADD COLUMN IF NOT EXISTS user_id TEXT;');
  await pool.query(
    'CREATE INDEX IF NOT EXISTS member_events_occurred_at_idx ON member_events (occurred_at);'
  );
  await pool.query(
    'CREATE INDEX IF NOT EXISTS member_events_user_id_idx ON member_events (user_id);'
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_count_samples (
      message_id   TEXT PRIMARY KEY,
      recorded_at  TIMESTAMPTZ NOT NULL,
      member_count INTEGER NOT NULL
    );
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS member_count_samples_recorded_at_idx ON member_count_samples (recorded_at);'
  );
}

// --- Collectors -----------------------------------------------------------
async function collectJoinsLeaves(channel, pool, { stopBeforeMs = null, quiet = false } = {}) {
  let joins = 0;
  let leaves = 0;
  let leavesNoId = 0;
  await eachMessage(
    channel,
    async (msg) => {
      let type = null;
      let userId = null;
      if (msg.type === MessageType.UserJoin) {
        type = 'join';
        userId = msg.author?.id ?? null; // the joiner authors the system message
      } else if (msg.author?.bot) {
        type = 'leave';
        userId = leaveUserId(msg);
        if (!userId) leavesNoId++;
      }
      if (!type) return;
      // ON CONFLICT DO UPDATE (not DO NOTHING) so a re-run backfills user_id into
      // rows stored before this column existed; guarded so we only fill blanks.
      const res = await pool.query(
        `INSERT INTO member_events (message_id, type, occurred_at, user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (message_id) DO UPDATE SET user_id = EXCLUDED.user_id
         WHERE member_events.user_id IS NULL AND EXCLUDED.user_id IS NOT NULL`,
        [msg.id, type, new Date(msg.createdTimestamp), userId]
      );
      if (res.rowCount > 0) type === 'join' ? joins++ : leaves++;
    },
    { stopBeforeMs, quiet }
  );
  if (!quiet) {
    console.log(
      `  Joins/leaves: ${joins} join, ${leaves} leave rows written` +
        (leavesNoId ? ` (${leavesNoId} leave post(s) had no parseable user id).` : '.')
    );
  }
  return { joins, leaves, leavesNoId };
}

async function collectMemberCounts(channel, pool, { stopBeforeMs = null, quiet = false } = {}) {
  // Paging newest→oldest, days only ever decrease. After we keep a sample for
  // day D we ignore matches until a message lands on a day ≤ D − SAMPLE_SKIP_DAYS.
  let lastKeptDay = null;
  let kept = 0;
  await eachMessage(
    channel,
    async (msg) => {
      const count = extractMemberCount(msg);
      if (count == null) return;
      const day = dayStartMs(msg.createdTimestamp);
      if (lastKeptDay != null && lastKeptDay - day < SAMPLE_SKIP_DAYS * DAY_MS) return;
      const res = await pool.query(
        `INSERT INTO member_count_samples (message_id, recorded_at, member_count)
         VALUES ($1, $2, $3) ON CONFLICT (message_id) DO NOTHING`,
        [msg.id, new Date(msg.createdTimestamp), count]
      );
      lastKeptDay = day;
      if (res.rowCount > 0) kept++;
    },
    { stopBeforeMs, quiet }
  );
  if (!quiet) console.log(`  Member counts: +${kept} sample rows inserted.`);
  return { kept };
}

// --- Orchestration --------------------------------------------------------
// One collection pass. `incremental` bounds each channel walk to just past what's
// already stored; a full scan (incremental=false) re-walks all history.
async function collect({ client, pool, incremental = false, quiet = false }) {
  await initSchema(pool);

  const jl = await withRetry(
    () => client.channels.fetch(JOINLEAVE_CHANNEL_ID),
    'fetch join/leave channel'
  );
  const jlStop = incremental ? await incrementalCutoff(pool, 'member_events', 'occurred_at') : null;
  if (!quiet) console.log(`Scanning joins/leaves in #${jl.name} (${jl.id})…`);
  const joinsLeaves = await collectJoinsLeaves(jl, pool, { stopBeforeMs: jlStop, quiet });

  const mc = await withRetry(
    () => client.channels.fetch(MEMBERCOUNT_CHANNEL_ID),
    'fetch member-count channel'
  );
  const mcStop = incremental
    ? await incrementalCutoff(pool, 'member_count_samples', 'recorded_at')
    : null;
  if (!quiet) console.log(`Scanning member counts in #${mc.name} (${mc.id})…`);
  const memberCounts = await collectMemberCounts(mc, pool, { stopBeforeMs: mcStop, quiet });

  return { joinsLeaves, memberCounts };
}

// --- Scheduled (in-bot) incremental run -----------------------------------
let running = false;

// Guarded so a slow scan that spills past the interval can't stack on itself.
async function run(client, pool) {
  if (running) return;
  running = true;
  const started = Date.now();
  try {
    const { joinsLeaves, memberCounts } = await collect({
      client,
      pool,
      incremental: true,
      quiet: true,
    });
    const added = joinsLeaves.joins + joinsLeaves.leaves + memberCounts.kept;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (added > 0) {
      console.log(
        `[member-stats] +${joinsLeaves.joins} join, +${joinsLeaves.leaves} leave, ` +
          `+${memberCounts.kept} count sample(s) in ${secs}s.`
      );
    } else {
      console.log(`[member-stats] up to date — no new rows (${secs}s).`);
    }
  } catch (err) {
    console.error('[member-stats] collection failed:', err.message);
  } finally {
    running = false;
  }
}

// ms from now until POST_MIDNIGHT_OFFSET_MIN past the next UTC midnight. If that
// point is still ahead today (bot booted in the first few minutes of the day),
// it targets today's; otherwise tomorrow's.
function msUntilPostMidnightUTC() {
  const now = Date.now();
  const d = new Date(now);
  let target = Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, POST_MIDNIGHT_OFFSET_MIN, 0, 0
  );
  if (target <= now) target += DAY_MS;
  return target - now;
}

// A boot catch-up (fills the current gap right after a start/restart), then a run
// just after every UTC midnight so the day that just completed lands in the DB as
// the chart rolls it from "in-progress" to a finished bar. The daily timer
// re-computes its delay each fire, so it stays pinned to UTC midnight without
// drift. Timers are unref'd so they never keep the process alive on their own.
function schedule(client, pool) {
  if (!ENABLED) return;
  const tick = () => run(client, pool).catch((err) => console.error('[member-stats]', err.message));
  setTimeout(tick, FIRST_RUN_DELAY_MS).unref?.();
  const armMidnight = () => {
    setTimeout(() => {
      tick();
      armMidnight(); // re-arm for the following midnight
    }, msUntilPostMidnightUTC()).unref?.();
  };
  armMidnight();
}

module.exports = {
  ENABLED,
  midnightOffsetMin: POST_MIDNIGHT_OFFSET_MIN,
  JOINLEAVE_CHANNEL_ID,
  MEMBERCOUNT_CHANNEL_ID,
  initSchema,
  collect,
  run,
  schedule,
};
