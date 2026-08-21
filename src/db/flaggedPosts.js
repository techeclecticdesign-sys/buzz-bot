// Link-check enforcement grace tracking (flagged_posts, one clock per post+reason).
const { query } = require('./pool');

// --- Link-check enforcement (grace tracking, one clock per post+reason) ---

// First-flagged timestamps for the given posts under one reason: id -> Date.
async function getFlaggedPosts(messageIds, reason) {
  if (!messageIds.length) return new Map();
  const { rows } = await query(
    'SELECT message_id, first_flagged_at FROM flagged_posts WHERE reason = $1 AND message_id = ANY($2)',
    [reason, messageIds]
  );
  return new Map(rows.map((r) => [r.message_id, r.first_flagged_at]));
}

// Stamp a post the first time it's seen in violation (starts its grace clock).
// Idempotent — re-flagging an already-tracked post keeps the original timestamp,
// so the clock never resets while the post stays in violation.
async function flagPost(messageId, reason, channelId, authorId) {
  await query(
    `INSERT INTO flagged_posts (message_id, reason, channel_id, author_id)
     VALUES ($1, $2, $3, $4) ON CONFLICT (message_id, reason) DO NOTHING`,
    [messageId, reason, channelId, authorId]
  );
}

async function clearFlaggedPosts(messageIds, reason) {
  if (!messageIds.length) return;
  await query('DELETE FROM flagged_posts WHERE reason = $1 AND message_id = ANY($2)', [reason, messageIds]);
}

// Drop stamps for this reason on every tracked post NOT in the current
// still-in-violation set — i.e. posts fixed or removed since last sweep — so a
// later re-offense starts a fresh clock. An empty set clears all of this reason.
async function clearResolvedFlaggedPosts(currentIds, reason) {
  await query('DELETE FROM flagged_posts WHERE reason = $1 AND NOT (message_id = ANY($2))', [reason, currentIds]);
}

// Every currently-tracked post for one reason (message + channel + author + when
// it was first flagged). The hourly pending re-check uses this to re-test only the
// small set of already-flagged posts, so it never has to rescan a channel. The
// table clears posts as soon as they're fixed or removed, so this stays tiny.
async function getFlaggedPostsByReason(reason) {
  const { rows } = await query(
    'SELECT message_id, channel_id, author_id, first_flagged_at FROM flagged_posts WHERE reason = $1',
    [reason]
  );
  return rows;
}

module.exports = {
  getFlaggedPosts,
  flagPost,
  clearFlaggedPosts,
  clearResolvedFlaggedPosts,
  getFlaggedPostsByReason,
};
