// rpc-web's trading cards: one row per member, written by the site. logger-bot
// only keeps `approved` in step with the card post's :staffapproved: reaction.
// Writes key on message_id, so a card replaced mid-check is never touched.
const { query } = require('./pool');

async function isTcgCardMessage(messageId) {
  const { rows } = await query('SELECT 1 FROM tcg_cards WHERE message_id = $1', [messageId]);
  return rows.length > 0;
}

// All cards, or only those never checked (checked_at is NULL until the first).
async function listTcgCards({ uncheckedOnly = false } = {}) {
  const { rows } = await query(
    `SELECT message_id, channel_id FROM tcg_cards${uncheckedOnly ? ' WHERE checked_at IS NULL' : ''}`
  );
  return rows;
}

async function setTcgCardApproval(messageId, approved) {
  await query(
    'UPDATE tcg_cards SET approved = $2, checked_at = now() WHERE message_id = $1',
    [messageId, approved]
  );
}

// Cards whose post (messageIds) or thread (channelId) was deleted.
async function unapproveDeletedTcgCards({ messageIds = [], channelId = null }) {
  await query(
    `UPDATE tcg_cards SET approved = false, checked_at = now()
      WHERE approved AND (message_id = ANY($1) OR channel_id = $2)`,
    [messageIds, channelId]
  );
}

module.exports = { isTcgCardMessage, listTcgCards, setTcgCardApproval, unapproveDeletedTcgCards };
