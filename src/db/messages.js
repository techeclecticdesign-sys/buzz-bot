// Queries against the messages table: the archive, edit/delete bookkeeping,
// group-advert image attachments, advert-failsafe reads, and the retention prunes.
const { pool, query } = require('./pool');
const jsonArchive = require('../jsonArchive');

// Append a message to the optional on-disk JSON archive (no DB write). No-ops
// unless JSON_ARCHIVE_DIR is set. Attachments live only here, not the DB. Kept
// separate from the insert so backfill can archive all history to JSON while
// writing only recent messages to the DB.
function archiveMessageJson(msg) {
  const attachments = [...msg.attachments.values()].map((a) => ({ name: a.name, url: a.url }));
  jsonArchive.append(msg.guildId, msg.channelId, msg.channel?.name, {
    type: 'message',
    id: msg.id,
    authorId: msg.author?.id ?? null,
    authorTag: msg.author?.tag ?? null,
    content: msg.content ?? '',
    attachments,
    createdAt: msg.createdAt?.toISOString() ?? null,
  });
}

// Insert a message into the DB archive. By default also mirrors it to the JSON
// archive on first insert; pass { archive: false } when the caller handles the
// JSON side itself (backfill, which archives on a different — all-time — cutoff).
//
// `reactions` (a reactionSummary array, or null) is only written when the key is
// present in opts — omitting it leaves the column untouched, so a plain content
// edit never clobbers a post's stored reactions. Live message creates omit it
// (a new message has none); backfill passes it for advert posts.
async function upsertMessage(msg, { archive = true, refresh = false, reactions } = {}) {
  const hasReactions = reactions !== undefined;
  const params = [
    msg.id,
    msg.channelId,
    msg.author?.id ?? null,
    msg.author?.tag ?? null,
    msg.content ?? '',
    msg.createdAt,
  ];

  const cols = ['id', 'channel_id', 'author_id', 'author_tag', 'content', 'created_at'];
  const vals = ['$1', '$2', '$3', '$4', '$5', '$6'];

  let editedIdx;
  if (refresh) {
    params.push(msg.editedAt ?? null);
    editedIdx = params.length;
  }
  let reactionsIdx;
  if (hasReactions) {
    params.push(reactions === null ? null : JSON.stringify(reactions));
    reactionsIdx = params.length;
    cols.push('reactions');
    vals.push(`$${reactionsIdx}`);
  }

  let onConflict = 'NOTHING';
  if (refresh) {
    const sets = [
      'channel_id = EXCLUDED.channel_id',
      'author_id = EXCLUDED.author_id',
      'author_tag = EXCLUDED.author_tag',
      'content = EXCLUDED.content',
      `edited_at = $${editedIdx}`,
      'deleted_at = NULL',
    ];
    if (hasReactions) sets.push(`reactions = $${reactionsIdx}`);
    onConflict = `UPDATE SET ${sets.join(', ')} RETURNING (xmax = 0) AS inserted`;
  }

  const res = await query(
    `INSERT INTO messages (${cols.join(', ')})
     VALUES (${vals.join(', ')})
     ON CONFLICT (id) DO ${onConflict}`,
    params
  );
  const inserted = refresh ? res.rows[0]?.inserted === true : res.rowCount === 1;
  if (inserted && archive) archiveMessageJson(msg);
  return inserted;
}

// Overwrite just the reaction summary for a stored message (no-op if the message
// isn't archived). Pass null to clear. Driven by the live reaction handlers.
async function setReactions(id, reactions) {
  await query(
    'UPDATE messages SET reactions = $2 WHERE id = $1',
    [id, reactions == null ? null : JSON.stringify(reactions)]
  );
}

async function getMessage(id) {
  const { rows } = await query('SELECT * FROM messages WHERE id = $1', [id]);
  return rows[0] ?? null;
}

async function getMessages(ids) {
  const { rows } = await query('SELECT * FROM messages WHERE id = ANY($1)', [ids]);
  return rows;
}

async function updateContent(id, content, editedAt) {
  await query(
    'UPDATE messages SET content = $2, edited_at = $3 WHERE id = $1',
    [id, content, editedAt]
  );
}

async function markDeleted(ids) {
  await query(
    'UPDATE messages SET deleted_at = now() WHERE id = ANY($1)',
    [Array.isArray(ids) ? ids : [ids]]
  );
}

// Replace the stored image attachments for a group advert. `images` is an array
// of { pos, filename, contentType, width, height, size, buffer }; pass [] to
// clear. Metadata (everything but the bytes) is written to messages.attachments
// for cheap layout reads on the site; the bytes go to group_advert_images. Done
// in one transaction so a reader never sees metadata without its bytes. The
// message row must already exist (callers upsert it first).
async function setAdvertAttachments(messageId, channelId, images) {
  const meta = images.map((a) => ({
    pos: a.pos,
    filename: a.filename ?? null,
    contentType: a.contentType,
    width: a.width ?? null,
    height: a.height ?? null,
    size: a.size ?? (a.buffer ? a.buffer.length : null),
  }));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('UPDATE messages SET attachments = $2 WHERE id = $1', [
      messageId,
      meta.length ? JSON.stringify(meta) : null,
    ]);
    await client.query('DELETE FROM group_advert_images WHERE message_id = $1', [messageId]);
    for (const a of images) {
      await client.query(
        `INSERT INTO group_advert_images (message_id, pos, channel_id, image, content_type)
         VALUES ($1, $2, $3, $4, $5)`,
        [messageId, a.pos, channelId, a.buffer, a.contentType]
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// Drop a group advert's stored images (metadata + bytes). Used when the post is
// deleted so nothing dangles.
async function clearAdvertAttachments(messageId) {
  await query('UPDATE messages SET attachments = NULL WHERE id = $1', [messageId]);
  await query('DELETE FROM group_advert_images WHERE message_id = $1', [messageId]);
}

// --- Advert failsafe (reads the message archive; no separate advert state) ---

// The user's most recent *standing* (non-deleted) post in a channel, excluding
// the message being evaluated. Drives duplicate-in-channel + cooldown.
async function getStandingAdvert(channelId, userId, excludeId) {
  const { rows } = await query(
    `SELECT id, content, created_at FROM messages
     WHERE channel_id = $1 AND author_id = $2 AND id <> $3 AND deleted_at IS NULL
     ORDER BY created_at DESC NULLS LAST LIMIT 1`,
    [channelId, userId, excludeId]
  );
  return rows[0] ?? null;
}

// The user's most recent *deleted* post in a channel, excluding the current one.
// Used for the delete-and-repost grace window when no standing post remains.
async function getLastDeletedAdvert(channelId, userId, excludeId) {
  const { rows } = await query(
    `SELECT id, content, created_at FROM messages
     WHERE channel_id = $1 AND author_id = $2 AND id <> $3 AND deleted_at IS NOT NULL
     ORDER BY created_at DESC NULLS LAST LIMIT 1`,
    [channelId, userId, excludeId]
  );
  return rows[0] ?? null;
}

// The user's most recent standing post in each of the given channels (one per
// channel), excluding the current channel. Drives cross-channel duplicate.
async function getStandingAdvertsInChannels(userId, channelIds, excludeChannelId) {
  const { rows } = await query(
    `SELECT DISTINCT ON (channel_id) channel_id, id, content, created_at
     FROM messages
     WHERE author_id = $1 AND channel_id = ANY($2) AND channel_id <> $3 AND deleted_at IS NULL
     ORDER BY channel_id, created_at DESC NULLS LAST`,
    [userId, channelIds, excludeChannelId]
  );
  return rows;
}

// --- Retention (prune the archive so DB storage stays bounded) ---
// These only trim the local database — nothing on Discord is touched.

// Delete up to `limit` archived messages IN the given channels older than
// `cutoff`. Batched via ctid so a huge first prune doesn't lock the table or
// trip a statement timeout. Returns the number of rows deleted. Rows with a
// NULL created_at are left alone (we can't age them).
async function pruneMessagesInChannels(channelIds, cutoff, limit = 5000) {
  const res = await query(
    `DELETE FROM messages
     WHERE ctid IN (
       SELECT ctid FROM messages
       WHERE channel_id = ANY($1::text[]) AND created_at IS NOT NULL AND created_at < $2
       LIMIT $3
     )`,
    [channelIds, cutoff, limit]
  );
  return res.rowCount;
}

// Same, but for messages NOT in the given channels (everything else). An empty
// channel list matches every channel, so all messages older than the cutoff go.
async function pruneMessagesNotInChannels(channelIds, cutoff, limit = 5000) {
  const res = await query(
    `DELETE FROM messages
     WHERE ctid IN (
       SELECT ctid FROM messages
       WHERE NOT (channel_id = ANY($1::text[])) AND created_at IS NOT NULL AND created_at < $2
       LIMIT $3
     )`,
    [channelIds, cutoff, limit]
  );
  return res.rowCount;
}

// Hard-delete messages that were deleted (deleted_at set) longer ago than
// `cutoff` — i.e. a post that's been logged and removed and is no longer needed
// by anything (see retention.js for why the cutoff must clear the advert repost
// cooldown). Any group_advert_images rows cascade away with them. Batched via
// ctid like the prunes above.
async function pruneSoftDeletedMessages(cutoff, limit = 5000) {
  const res = await query(
    `DELETE FROM messages
     WHERE ctid IN (
       SELECT ctid FROM messages
       WHERE deleted_at IS NOT NULL AND deleted_at < $1
       LIMIT $2
     )`,
    [cutoff, limit]
  );
  return res.rowCount;
}

module.exports = {
  archiveMessageJson,
  upsertMessage,
  setReactions,
  getMessage,
  getMessages,
  updateContent,
  markDeleted,
  setAdvertAttachments,
  clearAdvertAttachments,
  getStandingAdvert,
  getLastDeletedAdvert,
  getStandingAdvertsInChannels,
  pruneMessagesInChannels,
  pruneMessagesNotInChannels,
  pruneSoftDeletedMessages,
};
