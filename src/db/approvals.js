// Durable record of (author, advert-text) pairs that have carried :staffapproved:.
// One row per approved message. Kept current by the advert reaction sync: a post
// gaining the reaction upserts its row, losing it deletes the row. Rows survive
// message deletion / retention pruning on purpose — the point is to remember that
// an author had this exact ad approved even after the original post is gone.
const { query } = require('./pool');

async function upsertApprovedHash(messageId, authorId, contentHash, channelId) {
  await query(
    `INSERT INTO advert_approval_hashes (message_id, author_id, content_hash, channel_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (message_id) DO UPDATE
       SET author_id = EXCLUDED.author_id,
           content_hash = EXCLUDED.content_hash,
           channel_id = EXCLUDED.channel_id`,
    [messageId, authorId, contentHash, channelId]
  );
}

async function deleteApprovedHash(messageId) {
  await query('DELETE FROM advert_approval_hashes WHERE message_id = $1', [messageId]);
}

module.exports = { upsertApprovedHash, deleteApprovedHash };
