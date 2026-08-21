// #rule_infractions expiry sweep.
//
// YAGPDB's own 180-day expiry skips bot messages, so the pings this bot posts
// (link-check / advert advisories) would never age out. checkLinks.js and
// advertFailsafe.js record each ping via db.recordInfractionPost; this sweep
// deletes recorded pings older than TTL_DAYS and drops their rows. It only touches
// messages this bot recorded, so it can't delete YAGPDB's pings or the sticky.
// TTL_DAYS mirrors YAGPDB's 180 days so both halves age out together.

const db = require('./db');

// Fixed (not env-tunable): drives a destructive delete, hardcoded to YAGPDB's 180d.
const TTL_DAYS = 180;
const TTL_MS = TTL_DAYS * 24 * 60 * 60 * 1000;
// Cap per sweep so a backlog drains gradually instead of hammering the API in one
// burst; leftovers are picked up on the next tick.
const MAX_DELETES = 100;
// Every 6 hours, matching YAGPDB's 360-minute interval.
const POLL_MS = 6 * 60 * 60 * 1000;

const fetchChannelById = (client, id) =>
  client.channels.cache.get(id) ?? client.channels.fetch(id).catch(() => null);

// SAFETY GATE: delete only when the message is confirmed authored by THIS bot, so a
// bad id in the ledger can't remove a human's note or a YAGPDB ping. Fails closed
// on any unknown (no message / no author / no self id).
function isOwnInfractionPost(msg, selfId) {
  return !!(selfId && msg && msg.author && msg.author.id === selfId);
}

// One pass: delete ledgered pings past the TTL and forget their rows. Every
// candidate is FETCHED and authorship-checked before deletion (never a blind
// delete-by-id). A message that's already gone (10008) has its row dropped; a
// message that isn't ours is left in place and its stale row is dropped so it's
// never retried; a transient fetch/reach failure leaves the row for the next sweep.
async function runInfractionExpiry(client) {
  const selfId = client.user?.id;
  if (!selfId) {
    // Without a known self id we cannot prove ownership — do nothing rather than
    // risk deleting someone else's message.
    console.warn('[infr-expiry] skipped: client.user.id not available yet.');
    return;
  }
  let rows;
  try {
    rows = await db.getExpiredInfractionPosts(new Date(Date.now() - TTL_MS), MAX_DELETES);
  } catch (err) {
    console.error('[infr-expiry] due query failed:', err.message);
    return;
  }
  if (!rows.length) return;
  const done = []; // ledger rows to drop (deleted, already gone, or not ours)
  let removed = 0;
  for (const { message_id, channel_id } of rows) {
    const channel = await fetchChannelById(client, channel_id);
    if (!channel?.messages) continue; // can't reach it now — retry next sweep

    let msg;
    try {
      msg = await channel.messages.fetch(message_id);
    } catch (err) {
      if (err.code === 10008) {
        done.push(message_id); // already gone — just forget it
      } else {
        console.error(`[infr-expiry] fetch failed for ${message_id}: ${err.message}`);
        // transient — do NOT delete blind; leave the row and retry next sweep
      }
      continue;
    }

    if (!isOwnInfractionPost(msg, selfId)) {
      // Not our message — never delete it. Drop the mis-recorded row so we stop
      // tracking (and can never act on) an id that should never have been here.
      console.warn(
        `[infr-expiry] refusing to delete ${message_id} in ${channel_id}: not authored by this bot; dropping stale ledger row.`
      );
      done.push(message_id);
      continue;
    }

    try {
      await msg.delete();
      done.push(message_id);
      removed++;
    } catch (err) {
      if (err.code === 10008) done.push(message_id); // raced to gone — forget it
      else console.error(`[infr-expiry] delete failed for ${message_id}: ${err.message}`);
    }
  }
  if (done.length) {
    await db.deleteInfractionPostRecords(done).catch((err) =>
      console.error('[infr-expiry] ledger cleanup failed:', err.message)
    );
  }
  if (removed) console.log(`[infr-expiry] removed ${removed} expired #rule_infractions post(s).`);
}

// In-process poll loop (hosts here run `npm start` with no cron), mirroring
// checkLinks.scheduleLinkCheck / advertFailsafe.scheduleRechecks. A re-entrancy
// guard keeps a slow sweep from overlapping itself. Fires once shortly after boot
// so a restart doesn't wait 6h to resume draining a backlog.
function scheduleInfractionExpiry(client) {
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runInfractionExpiry(client);
    } finally {
      running = false;
    }
  };
  setInterval(tick, POLL_MS).unref?.();
  setTimeout(tick, 60 * 1000).unref?.(); // first pass ~1 min after ready
  console.log(`[infr-expiry] armed — expiring our #rule_infractions posts after ${TTL_DAYS} days.`);
}

module.exports = { runInfractionExpiry, scheduleInfractionExpiry, isOwnInfractionPost };
