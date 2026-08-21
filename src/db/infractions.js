// Edit-infraction advisory tracking + re-check queue (advert_infractions) and the
// #rule_infractions post ledger (infraction_posts).
const { query } = require('./pool');

// --- Edit-infraction advisory tracking + re-check queue ---

// The current row for a post (advisory id we posted, its channel, re-check
// stage), or null if none is outstanding. Used by bump (needs advisory_id).
async function getAdvertInfraction(advertId) {
  const { rows } = await query(
    'SELECT advert_id, advisory_id, channel_id, stage, next_check_at FROM advert_infractions WHERE advert_id = $1',
    [advertId]
  );
  return rows[0] ?? null;
}

// Record the advisory we just posted for a post and (re)arm its re-check clock at
// stage 1. Replaces any prior row for the post (a fresh edit restarts the clock).
async function setAdvertInfraction(advertId, advisoryId, channelId, nextCheckAt) {
  await query(
    `INSERT INTO advert_infractions (advert_id, advisory_id, channel_id, stage, next_check_at, updated_at)
     VALUES ($1, $2, $3, 1, $4, now())
     ON CONFLICT (advert_id)
       DO UPDATE SET advisory_id = $2, channel_id = $3, stage = 1, next_check_at = $4, updated_at = now()`,
    [advertId, advisoryId, channelId, nextCheckAt]
  );
}

// Rows whose re-check is due (next_check_at at or before `now`). Oldest first.
async function getDueRechecks(now, limit = 50) {
  const { rows } = await query(
    `SELECT advert_id, advisory_id, channel_id, stage, next_check_at
     FROM advert_infractions
     WHERE next_check_at IS NOT NULL AND next_check_at <= $1
     ORDER BY next_check_at ASC LIMIT $2`,
    [now, limit]
  );
  return rows;
}

// Advance a still-dirty post to its next re-check stage/time. Guarded on
// advisory_id: if a concurrent edit re-armed the row with a NEW advisory while
// this sweep was in flight, the id won't match and the stale advance no-ops
// (the fresh advisory keeps its own stage-1 clock).
async function advanceRecheck(advertId, stage, nextCheckAt, advisoryId) {
  await query(
    'UPDATE advert_infractions SET stage = $2, next_check_at = $3, updated_at = now() WHERE advert_id = $1 AND advisory_id = $4',
    [advertId, stage, nextCheckAt, advisoryId]
  );
}

// Drop the row. `advisoryId`, when given, guards against clobbering a newer
// advisory a concurrent edit armed while this sweep was resolving the old one —
// only the row still pointing at the advisory we acted on is deleted.
async function clearAdvertInfraction(advertId, advisoryId) {
  if (advisoryId) {
    await query('DELETE FROM advert_infractions WHERE advert_id = $1 AND advisory_id = $2', [advertId, advisoryId]);
  } else {
    await query('DELETE FROM advert_infractions WHERE advert_id = $1', [advertId]);
  }
}

// --- #rule_infractions post ledger (our own 180-day expiry, since YAGPDB
//     can't see our bot posts to expire them) ---

// Remember a ping we posted into #rule_infractions so the expiry sweep can delete
// it once it ages out. Idempotent on message id.
async function recordInfractionPost(messageId, channelId) {
  await query(
    `INSERT INTO infraction_posts (message_id, channel_id)
     VALUES ($1, $2) ON CONFLICT (message_id) DO NOTHING`,
    [messageId, channelId]
  );
}

// Ledgered posts older than `cutoff` (oldest first), capped at `limit` so one
// sweep can't try to delete an unbounded batch. Returns {message_id, channel_id}.
async function getExpiredInfractionPosts(cutoff, limit = 200) {
  const { rows } = await query(
    `SELECT message_id, channel_id FROM infraction_posts
     WHERE posted_at <= $1 ORDER BY posted_at ASC LIMIT $2`,
    [cutoff, limit]
  );
  return rows;
}

// Drop ledger rows once their messages are deleted (or already gone).
async function deleteInfractionPostRecords(messageIds) {
  if (!messageIds.length) return;
  await query('DELETE FROM infraction_posts WHERE message_id = ANY($1)', [messageIds]);
}

module.exports = {
  getAdvertInfraction,
  setAdvertInfraction,
  getDueRechecks,
  advanceRecheck,
  clearAdvertInfraction,
  recordInfractionPost,
  getExpiredInfractionPosts,
  deleteInfractionPostRecords,
};
