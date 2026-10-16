// Daily advert reconcile.
//
// The live gateway only marks deletes it actually witnesses, so any advert
// removed while the bot is offline lingers in the DB with deleted_at NULL — a
// "phantom" that keeps showing on the website and in the mod-approval queue.
// This sweep asks Discord about every standing advert and soft-deletes only the
// ones it can positively confirm are gone (Unknown Message / 10008). Anything it
// can't verify — unreadable channel, permission error, rate limit, network blip —
// is left untouched and retried next run, exactly like the link-check
// revalidation (checkLinks.fetchCurrentPost).
//
// Soft-delete only: db.markDeleted sets deleted_at = now(); nothing on Discord is
// touched. Retention (pruneSoftDeletedMessages) hard-prunes the rows later.
const db = require('./db');
const advertConfig = require('./advertConfig');
const config = require('./config');

const ENABLED = config.bool('ADVERT_RECONCILE_ENABLED', true);
// Hour (0-23) to run, interpreted in US Eastern (DST-aware, see easternNow).
const TARGET_HOUR = config.num('ADVERT_RECONCILE_HOUR', 3, { min: 0, max: 23 });
const TIME_ZONE = 'America/New_York';
const POLL_MS = 30 * 60 * 1000; // check the clock twice an hour
const FETCH_DELAY_MS = 80; // gentle pacing between per-message lookups

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// { date: 'YYYY-MM-DD', hour: 0-23 } in US Eastern, so "3" means 3am ET whatever
// the host clock is set to, and spring/fall DST shifts are handled for us.
function easternNow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

// One full pass. Never throws for a single bad row; returns a summary.
async function runAdvertReconcile(client) {
  const channelIds = advertConfig.ALL_ADVERT_CHANNELS ?? [];
  if (!channelIds.length) {
    console.log('[advert-reconcile] no advert channels configured — nothing to check.');
    return { checked: 0, live: 0, gone: 0, skipped: 0 };
  }

  const { rows } = await db.pool.query(
    `SELECT id, channel_id FROM messages
      WHERE channel_id = ANY($1) AND deleted_at IS NULL`,
    [channelIds]
  );
  if (!rows.length) {
    console.log('[advert-reconcile] no standing adverts to check.');
    return { checked: 0, live: 0, gone: 0, skipped: 0 };
  }

  console.log(`[advert-reconcile] checking ${rows.length} standing advert(s) against Discord.`);
  const channelCache = new Map(); // channel_id -> channel | null (fetched once each)
  const goneIds = [];
  let live = 0;
  let skipped = 0;

  for (const row of rows) {
    let channel = channelCache.get(row.channel_id);
    if (channel === undefined) {
      channel = await client.channels.fetch(row.channel_id).catch(() => null);
      channelCache.set(row.channel_id, channel);
    }
    // Can't read the channel (deleted, or access lost) — never infer a message
    // delete from that; leave the row and retry next run.
    if (!channel?.messages) {
      skipped++;
      continue;
    }
    try {
      await channel.messages.fetch(row.id);
      live++;
    } catch (err) {
      if (err?.code === 10008) goneIds.push(row.id); // Unknown Message — confirmed gone
      else skipped++; // transient / permission — do NOT delete
    }
    await sleep(FETCH_DELAY_MS);
  }

  if (goneIds.length) await db.markDeleted(goneIds);
  console.log(
    `[advert-reconcile] done: ${live} live, ${goneIds.length} soft-deleted (gone), ` +
      `${skipped} unverified/skipped of ${rows.length} checked.`
  );
  return { checked: rows.length, live, gone: goneIds.length, skipped };
}

// Poll-based daily scheduler (same shape as the link-check scheduler). Fires once
// per Eastern calendar day when the Eastern hour reaches TARGET_HOUR. It does NOT
// run on boot — only when that wall-clock hour next comes around.
let lastRunDate = null; // 'YYYY-MM-DD' (Eastern) of the last completed run
let running = false;

function scheduleAdvertReconcile(client) {
  if (!ENABLED) {
    console.log('[advert-reconcile] disabled (ADVERT_RECONCILE_ENABLED=false).');
    return;
  }
  const tick = async () => {
    if (running) return;
    const { date, hour } = easternNow();
    if (hour !== TARGET_HOUR || lastRunDate === date) return;
    running = true;
    lastRunDate = date; // claim the day up front so a slow run can't double-fire
    try {
      await runAdvertReconcile(client);
    } catch (err) {
      console.error('[advert-reconcile] scheduled run failed:', err.message);
    } finally {
      running = false;
    }
  };
  setInterval(tick, POLL_MS).unref?.();
  console.log(
    `[advert-reconcile] armed — daily around ${String(TARGET_HOUR).padStart(2, '0')}:00 ${TIME_ZONE}.`
  );
}

module.exports = { runAdvertReconcile, scheduleAdvertReconcile };
