// One-time (re-runnable) script: walks every readable channel + thread and archives
// message history (Discord pages newest→oldest).
//
// Two destinations: the DB (only messages inside the retention window — older would
// be pruned anyway) and, when JSON_ARCHIVE_DIR is set, the local JSON archive (ALL
// history, no cutoff). Unset → paging stops at the DB cutoff.
//
// Safe to re-run for the DB (existing rows refresh, new rows insert). The JSON
// archive is append-only, so re-running appends all-time history again — regenerate
// with `npm run export-json` or clear the JSON dir first.
//
// Modes:
//   INCREMENTAL (--incremental / BACKFILL_INCREMENTAL): only pull messages newer
//     than what's stored — skips a channel entirely if its last message is already
//     in the DB, else pages until the first stored message. Fills gaps at the recent
//     end only; a mid-history gap needs a full backfill.
//   ADVERTS-ONLY (--adverts / BACKFILL_ADVERTS_ONLY): walk only the configured
//     advert channels (no threads/other channels) to refresh reaction counts cheaply
//     without re-scanning the huge general channels. JSON archiving off in this mode;
//     run it non-incremental so stored adverts' reactions refresh.
require('dotenv').config();
const { Client, Events, GatewayIntentBits } = require('discord.js');
const db = require('./db');
const { isIgnoredChannel } = require('./ignoredChannels');
const advertConfig = require('./advertConfig');
const { reactionSummary } = require('./reactions');
const { siteAdvertAuthor } = require('./advertAttribution');
const config = require('./config');

// Mirror the live bot's IGNORE_BOTS behaviour so a backfill doesn't re-seed the
// archive with the very bot posts the running bot is configured to skip.
const IGNORE_BOTS = config.flag('IGNORE_BOTS');

// Same retention windows as src/retention.js: advert channels keep 1 year of
// history, everything else 2 years. Backfilling past those would archive rows
// the retention prune deletes on its next daily run — wasted API calls and a
// Neon storage spike for nothing.
const DAY_MS = 24 * 60 * 60 * 1000;
// Clamped to ≥1, matching retention.js (a negative value would skip everything).
const ADVERT_RETENTION_DAYS = config.num('ADVERT_RETENTION_DAYS', 365, { min: 1 });
const OTHER_RETENTION_DAYS = config.num('MESSAGE_RETENTION_DAYS', 730, { min: 1 });
const RUN_STARTED_AT = Date.now(); // one consistent cutoff for the whole run
const ADVERT_CHANNELS = new Set(advertConfig.ALL_ADVERT_CHANNELS);

// Adverts-only mode: walk ONLY the configured advert channels — skipping threads
// and every other channel entirely. This is the cheap one-off for seeding /
// refreshing advert reaction counts without re-scanning the huge general
// channels; reactions ride along in each fetched message for free. It's the same
// script and the same DB write path as a full backfill, just scoped, so there's
// no second command to maintain.
const ADVERTS_ONLY =
  process.argv.includes('--adverts') || config.flag('BACKFILL_ADVERTS_ONLY');

// When a JSON archive dir is configured we walk each channel's FULL history so
// the offline copy is complete; the DB still only takes messages within the
// retention window. Unset = stop at the DB cutoff (nothing older is wanted).
// Adverts-only never touches the JSON archive — it's a DB-only reaction refresh,
// and re-appending advert history to the append-only archive would duplicate it.
const ARCHIVE_ALL = !!process.env.JSON_ARCHIVE_DIR && !ADVERTS_ONLY;

// Only fetch messages newer than what's already stored (see the header note).
const INCREMENTAL =
  process.argv.includes('--incremental') || config.flag('BACKFILL_INCREMENTAL');

// Running totals across the whole run (DB rows vs. JSON records — they differ
// whenever ARCHIVE_ALL reaches past the retention window).
let dbGrandTotal = 0;
let jsonGrandTotal = 0;

// Oldest message timestamp (ms) worth archiving for this channel. Matches
// retention's semantics exactly: rows are pruned by their own channel_id, so a
// thread (even under an advert channel) is keyed by its thread id and gets the
// longer window — mirror that here.
function cutoffFor(channel) {
  const days = ADVERT_CHANNELS.has(channel.id) ? ADVERT_RETENTION_DAYS : OTHER_RETENTION_DAYS;
  return RUN_STARTED_AT - days * DAY_MS;
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// Retries transient failures (DNS dropouts, timeouts) with exponential
// backoff. Permission/API errors (4xx) are not retryable and rethrow at once.
async function withRetry(fn, label, attempts = 6) {
  let delay = 5000;
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.status ?? err.httpStatus;
      if ((status >= 400 && status < 500) || i >= attempts) throw err;
      console.warn(
        `  ! ${label}: ${err.message} — retrying in ${delay / 1000}s (${i}/${attempts - 1})`
      );
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(delay * 2, 60_000);
    }
  }
}

async function backfillChannel(channel) {
  const cutoff = cutoffFor(channel);

  // Incremental fast path: if the channel's newest message is already stored,
  // nothing is new here — skip without a single history fetch.
  if (INCREMENTAL && channel.lastMessageId && (await db.getMessage(channel.lastMessageId))) {
    return 0;
  }

  let before;
  let dbCount = 0;
  let jsonCount = 0;
  let reachedKnown = false;
  for (;;) {
    let batch;
    try {
      batch = await withRetry(
        () => channel.messages.fetch({ limit: 100, before }),
        `#${channel.name}`
      );
    } catch (err) {
      console.warn(`  ! ${channel.name}: giving up: ${err.message}`);
      break;
    }
    if (batch.size === 0) break;
    for (const msg of batch.values()) {
      if (msg.channelId === process.env.LOG_CHANNEL_ID) continue;
      // Ads posted from rpc-web are webhook (bot) posts credited to a member.
      const siteAuthor = siteAdvertAuthor(msg, client.application?.id, advertConfig.ALL_ADVERT_CHANNELS);
      if (IGNORE_BOTS && msg.author?.bot && !siteAuthor) continue;
      // Incremental: batches run newest→oldest, so the first already-stored
      // message marks the boundary — every remaining message is older and
      // therefore already archived. Stop here.
      if (INCREMENTAL && (await db.getMessage(msg.id))) {
        reachedKnown = true;
        break;
      }
      const withinCutoff = msg.createdTimestamp >= cutoff;
      // JSON archive: all of history (when configured). DB: only within cutoff.
      if (ARCHIVE_ALL) {
        db.archiveMessageJson(msg);
        jsonCount++;
      }
      if (withinCutoff) {
        // Advert posts carry a reaction summary (the fetched message already
        // includes reaction counts — no extra API call). Passing `undefined`
        // for everything else leaves the column untouched.
        const reactions = ADVERT_CHANNELS.has(msg.channelId)
          ? reactionSummary(msg)
          : undefined;
        await db.upsertMessage(msg, { archive: false, refresh: true, reactions, author: siteAuthor ?? undefined });
        dbCount++;
      }
    }
    // Hit a message we already have — the rest of history is stored too.
    if (reachedKnown) break;
    // Batches are newest→oldest. Once this page's oldest message is past the
    // cutoff, every remaining page is older still — so the DB is done. Keep
    // paging only when ARCHIVE_ALL still wants the older history for JSON.
    if (!ARCHIVE_ALL && batch.last().createdTimestamp < cutoff) break;
    before = batch.last().id;
    process.stdout.write(
      `  #${channel.name}: ${dbCount} to DB${ARCHIVE_ALL ? `, ${jsonCount} to JSON` : ''}\r`
    );
  }
  if (dbCount || jsonCount) {
    console.log(
      `  #${channel.name}: ${dbCount} to DB${ARCHIVE_ALL ? `, ${jsonCount} to JSON` : ''}`
    );
  }
  dbGrandTotal += dbCount;
  jsonGrandTotal += jsonCount;
  return dbCount;
}

async function backfillArchivedThreads(channel) {
  let total = 0;
  let before;
  for (;;) {
    const { threads, hasMore } = await withRetry(
      () => channel.threads.fetchArchived({ before, limit: 100 }),
      `archived threads of #${channel.name}`
    );
    for (const thread of threads.values()) {
      if (isIgnoredChannel(thread)) continue;
      // Threads page newest-archived first, and a thread's messages always
      // predate its archive time — so a thread archived before the retention
      // cutoff has nothing in-window for the DB, and neither does anything after
      // it. Stop here — unless ARCHIVE_ALL still wants these old threads for JSON.
      if (!ARCHIVE_ALL && thread.archivedAt && thread.archivedAt.getTime() < cutoffFor(thread)) {
        return total;
      }
      total += await backfillChannel(thread);
    }
    // Pagination is by archive timestamp; without one we can't safely continue.
    before = threads.last()?.archivedAt;
    if (!hasMore || threads.size === 0 || !before) break;
  }
  return total;
}

client.once(Events.ClientReady, async () => {
  console.log(
    `Logged in as ${client.user.tag} — starting ${INCREMENTAL ? 'incremental ' : ''}` +
      `${ADVERTS_ONLY ? 'adverts-only ' : ''}backfill.`
  );
  if (ADVERTS_ONLY) {
    if (ADVERT_CHANNELS.size === 0) {
      console.error('Adverts-only requested but no advert channels are configured (advertConfig). Nothing to do.');
      await db.pool.end();
      client.destroy();
      process.exit(0);
    }
    console.log(`Adverts-only: ${ADVERT_CHANNELS.size} advert channel(s); threads and all other channels skipped.`);
  }
  if (INCREMENTAL) {
    console.log('Incremental: only messages newer than what is already stored.');
  }
  if (ARCHIVE_ALL) {
    console.log(`JSON archive → ${process.env.JSON_ARCHIVE_DIR} (all history); DB → within retention cutoffs.`);
  } else {
    console.log('JSON archive off (JSON_ARCHIVE_DIR unset); DB → within retention cutoffs.');
  }

  for (const guild of client.guilds.cache.values()) {
    console.log(`Guild: ${guild.name}`);
    const channels = await withRetry(() => guild.channels.fetch(), `channels of ${guild.name}`);

    // Text-based channels hold messages directly; thread-only channels
    // (forums, media) hold them solely inside their threads.
    const targets = [...channels.values()].filter(
      (c) =>
        c &&
        (c.isTextBased() || c.isThreadOnly()) &&
        c.viewable &&
        c.id !== process.env.LOG_CHANNEL_ID &&
        !isIgnoredChannel(c) &&
        // Adverts-only: restrict to the configured advert channels.
        (!ADVERTS_ONLY || ADVERT_CHANNELS.has(c.id))
    );

    for (const channel of targets) {
      if (channel.isTextBased()) await backfillChannel(channel);
      // Adverts live in the channel itself, never in threads — skip thread
      // walking entirely in adverts-only mode.
      if (!ADVERTS_ONLY && channel.threads) {
        try {
          const active = await withRetry(
            () => channel.threads.fetchActive(),
            `active threads of #${channel.name}`
          );
          for (const thread of active.threads.values()) {
            if (isIgnoredChannel(thread)) continue;
            await backfillChannel(thread);
          }
          await backfillArchivedThreads(channel);
        } catch (err) {
          console.warn(`  ! threads of ${channel.name}: ${err.message}`);
        }
      }
    }
  }

  console.log(
    `Done. ${dbGrandTotal} message(s) written to the DB` +
      (ARCHIVE_ALL ? `, ${jsonGrandTotal} archived to JSON.` : '.')
  );
  await db.pool.end();
  client.destroy();
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  console.error('[unhandled]', err);
  process.exit(1);
});

db.init()
  .then(() => client.login(process.env.DISCORD_TOKEN))
  .catch((err) => {
    console.error('Startup failed:', err);
    process.exit(1);
  });
