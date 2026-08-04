const { Pool } = require('pg');
const jsonArchive = require('./jsonArchive');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

// Neon closes idle connections when its compute autosuspends; without this
// handler a dropped idle client crashes the process.
pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

// Transient network/Neon-wakeup errors shouldn't lose a message: retry with
// backoff before giving up.
async function query(text, params, attempts = 3) {
  let delay = 2000;
  for (let i = 1; ; i++) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      if (i >= attempts) throw err;
      console.warn(`[db] ${err.message} — retrying in ${delay / 1000}s (${i}/${attempts - 1})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

async function init() {
  // This bot only ever serves the one server, so guild_id was redundant on
  // every table and is dropped to save storage. Message attachments are no
  // longer archived either (they were the bulk of the row size). Each block
  // below creates the current schema for fresh databases and migrates existing
  // ones in place. Note: DROP COLUMN doesn't reclaim disk on its own — run
  // `VACUUM FULL` (or let autovacuum churn) afterwards to actually shrink files.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      channel_id  TEXT NOT NULL,
      author_id   TEXT,
      author_tag  TEXT,
      content     TEXT,
      created_at  TIMESTAMPTZ,
      edited_at   TIMESTAMPTZ,
      deleted_at  TIMESTAMPTZ
    );
  `);
  // guild_id is not part of the messages PK, so these drop cleanly in place.
  await pool.query('ALTER TABLE messages DROP COLUMN IF EXISTS guild_id;');
  await pool.query('ALTER TABLE messages DROP COLUMN IF EXISTS attachments;');
  // Reaction summary for advert posts (only advert channels are populated). Each
  // element is { id, name, animated, count }; NULL means no reactions. Kept live
  // by the reaction handlers and (re)seeded by backfill from the fetched message.
  await pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS reactions JSONB;');
  await pool.query(
    'CREATE INDEX IF NOT EXISTS messages_channel_idx ON messages (channel_id);'
  );
  // Speeds the daily retention prune (created_at < cutoff) and the advert
  // cleanup's age query.
  await pool.query(
    'CREATE INDEX IF NOT EXISTS messages_created_idx ON messages (created_at);'
  );

  // Link-check enforcement state: when the daily sweep first finds a post in
  // violation (a dead invite, or a server advertised in more than one channel)
  // it stamps it here under a `reason`, and once the stamp is past the grace
  // window (LINK_CHECK_GRACE_HOURS) and the post is still in violation it gets
  // deleted. Persisting the stamp is what makes the 24h clock survive restarts;
  // rows clear as soon as a post is fixed or deleted, so this stays tiny.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS flagged_posts (
      message_id       TEXT NOT NULL,
      reason           TEXT NOT NULL,
      channel_id       TEXT NOT NULL,
      author_id        TEXT,
      first_flagged_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (message_id, reason)
    );
  `);
  // Fold the earlier dead-link-only table into the generalized one, then drop it.
  await pool.query(`
    DO $$ BEGIN
      IF to_regclass('public.dead_link_posts') IS NOT NULL THEN
        INSERT INTO flagged_posts (message_id, reason, channel_id, author_id, first_flagged_at)
          SELECT message_id, 'dead_link', channel_id, author_id, first_flagged_at
          FROM dead_link_posts
          ON CONFLICT (message_id, reason) DO NOTHING;
        DROP TABLE dead_link_posts;
      END IF;
    END $$;
  `);

  // Last-known nickname + roles per member. Diffing incoming member updates
  // against this (rather than the event's oldMember, which is empty for
  // uncached members after a restart) makes change detection reliable.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_state (
      user_id    TEXT PRIMARY KEY,
      user_tag   TEXT,
      nickname   TEXT,
      role_ids   TEXT[] NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ
    );
  `);
  // Migrate an existing (guild_id, user_id) table: guild_id was half the PK, so
  // drop the composite PK, drop the column, and re-key on user_id alone. Guarded
  // on guild_id still existing so it's a no-op after the first migrated startup.
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'member_state' AND column_name = 'guild_id') THEN
        ALTER TABLE member_state DROP CONSTRAINT IF EXISTS member_state_pkey;
        ALTER TABLE member_state DROP COLUMN guild_id;
        ALTER TABLE member_state ADD PRIMARY KEY (user_id);
      END IF;
    END $$;
  `);
  // display_name = what Discord actually renders (nickname ?? globalName ??
  // username). nickname alone is NULL for members who never set a server nick,
  // so it's the wrong thing to display; this column carries the real label.
  await pool.query(
    'ALTER TABLE member_state ADD COLUMN IF NOT EXISTS display_name TEXT;'
  );

  // Append-only history: one row per nickname change (new value; NULL = reset
  // to plain username) and one row per role add/remove.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS nickname_history (
      id         BIGSERIAL PRIMARY KEY,
      user_id    TEXT NOT NULL,
      user_tag   TEXT,
      nickname   TEXT,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Dropping guild_id also drops the old (guild_id, user_id) index that depends
  // on it; recreate it on user_id alone below.
  await pool.query('ALTER TABLE nickname_history DROP COLUMN IF EXISTS guild_id;');
  await pool.query(
    'CREATE INDEX IF NOT EXISTS nickname_history_user_idx ON nickname_history (user_id);'
  );
  await pool.query(`
    CREATE TABLE IF NOT EXISTS role_history (
      id         BIGSERIAL PRIMARY KEY,
      user_id    TEXT NOT NULL,
      user_tag   TEXT,
      role_id    TEXT NOT NULL,
      role_name  TEXT,
      action     TEXT NOT NULL,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query('ALTER TABLE role_history DROP COLUMN IF EXISTS guild_id;');
  await pool.query(
    'CREATE INDEX IF NOT EXISTS role_history_user_idx ON role_history (user_id);'
  );

  // Per-guild logging preferences, all toggled via >>settings. Message
  // edits/deletes and name changes are always logged (when posting is on); role
  // changes are opt-in (default off). log_to_channel is a master switch for
  // posting to the log channel — off pauses all log-channel output while the DB
  // archive keeps running. Default off: the bot archives silently until an owner
  // turns posting on.
  // One server, one settings row — keyed on a constant id instead of guild_id.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      id               INT PRIMARY KEY DEFAULT 1,
      log_role_changes BOOLEAN NOT NULL DEFAULT false,
      log_to_channel   BOOLEAN NOT NULL DEFAULT false,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Add log_to_channel to databases created before it existed. Defaults off, so
  // any existing servers also start paused until an owner turns posting on.
  await pool.query(
    'ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS log_to_channel BOOLEAN NOT NULL DEFAULT false;'
  );
  // Migrate a guild_id-keyed table down to the single-row form: collapse to one
  // row (there was only ever one), drop guild_id, and re-key on id = 1.
  await pool.query(`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'guild_settings' AND column_name = 'guild_id') THEN
        DELETE FROM guild_settings a USING guild_settings b WHERE a.ctid < b.ctid;
        ALTER TABLE guild_settings DROP CONSTRAINT IF EXISTS guild_settings_pkey;
        ALTER TABLE guild_settings DROP COLUMN guild_id;
        ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS id INT;
        UPDATE guild_settings SET id = 1;
        ALTER TABLE guild_settings ALTER COLUMN id SET DEFAULT 1;
        ALTER TABLE guild_settings ADD PRIMARY KEY (id);
      END IF;
    END $$;
  `);

  // Last-known account-level names per user, for detecting username / display
  // name changes reliably across restarts — the userUpdate event's oldUser is
  // empty for uncached users, the same problem member_state solves for members.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_state (
      user_id     TEXT PRIMARY KEY,
      username    TEXT,
      global_name TEXT,
      updated_at  TIMESTAMPTZ
    );
  `);

  // Append-only history of account-level name changes. Server nicknames stay in
  // nickname_history since they're per-guild; these two names are global.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS name_history (
      id         BIGSERIAL PRIMARY KEY,
      user_id    TEXT NOT NULL,
      user_tag   TEXT,
      kind       TEXT NOT NULL,
      old_value  TEXT,
      new_value  TEXT,
      changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query('ALTER TABLE name_history DROP COLUMN IF EXISTS guild_id;');
  await pool.query(
    'CREATE INDEX IF NOT EXISTS name_history_user_idx ON name_history (user_id);'
  );
}

// Append a full message record to the optional on-disk JSON archive (no DB
// write). No-ops unless JSON_ARCHIVE_DIR is set. Attachments aren't stored in
// the DB (they dominated row size) but are cheap to keep in this offline copy.
// Kept separate from the DB insert so backfill can archive all of history to
// JSON while only writing recent messages to the DB.
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

// --- Member state (nickname + role tracking) ---

async function getMemberState(userId) {
  const { rows } = await query(
    'SELECT * FROM member_state WHERE user_id = $1',
    [userId]
  );
  return rows[0] ?? null;
}

// Insert a baseline only if we've never seen this member — never clobbers an
// existing state (used when priming on startup / member join). The one
// exception is display_name: an existing NULL is backfilled from the seed so a
// plain restart populates the column for members recorded before it existed.
async function seedMemberState(userId, userTag, nickname, roleIds, displayName = null) {
  await query(
    `INSERT INTO member_state (user_id, user_tag, nickname, display_name, role_ids, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (user_id)
       DO UPDATE SET display_name = COALESCE(member_state.display_name, EXCLUDED.display_name)`,
    [userId, userTag, nickname, displayName, roleIds]
  );
}

async function setMemberState(userId, userTag, nickname, roleIds, displayName = null) {
  await query(
    `INSERT INTO member_state (user_id, user_tag, nickname, display_name, role_ids, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (user_id)
       DO UPDATE SET user_tag = $2, nickname = $3, display_name = $4,
                     role_ids = $5, updated_at = now()`,
    [userId, userTag, nickname, displayName, roleIds]
  );
}

async function recordNickname(userId, userTag, nickname) {
  await query(
    `INSERT INTO nickname_history (user_id, user_tag, nickname)
     VALUES ($1, $2, $3)`,
    [userId, userTag, nickname]
  );
}

async function recordRoleChange(userId, userTag, roleId, roleName, action) {
  await query(
    `INSERT INTO role_history (user_id, user_tag, role_id, role_name, action)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, userTag, roleId, roleName, action]
  );
}

async function getNicknameHistory(userId, limit = 50) {
  const { rows } = await query(
    `SELECT nickname, changed_at FROM nickname_history
     WHERE user_id = $1
     ORDER BY changed_at ASC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

async function getRoleHistory(userId, limit = 50) {
  const { rows } = await query(
    `SELECT role_id, role_name, action, changed_at FROM role_history
     WHERE user_id = $1
     ORDER BY changed_at DESC LIMIT $2`,
    [userId, limit]
  );
  return rows;
}

// --- Guild settings (>>settings) ---

// Returns the single settings row with booleans; falls back to defaults before
// it's ever been saved.
async function getGuildSettings() {
  const { rows } = await query('SELECT * FROM guild_settings WHERE id = 1');
  return rows[0] ?? { log_role_changes: false, log_to_channel: false };
}

// Writes the full settings row. Pass the complete desired state (the caller
// merges its one changed toggle into the current settings first).
async function setGuildSettings({ log_role_changes, log_to_channel }) {
  await query(
    `INSERT INTO guild_settings (id, log_role_changes, log_to_channel, updated_at)
     VALUES (1, $1, $2, now())
     ON CONFLICT (id)
       DO UPDATE SET log_role_changes = $1, log_to_channel = $2, updated_at = now()`,
    [log_role_changes, log_to_channel]
  );
}

// --- User state (account-level username / display-name tracking) ---

async function getUserState(userId) {
  const { rows } = await query('SELECT * FROM user_state WHERE user_id = $1', [userId]);
  return rows[0] ?? null;
}

// Insert a baseline only if we've never seen this user (priming on startup/join).
async function seedUserState(userId, username, globalName) {
  await query(
    `INSERT INTO user_state (user_id, username, global_name, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id) DO NOTHING`,
    [userId, username, globalName]
  );
}

async function setUserState(userId, username, globalName) {
  await query(
    `INSERT INTO user_state (user_id, username, global_name, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (user_id)
       DO UPDATE SET username = $2, global_name = $3, updated_at = now()`,
    [userId, username, globalName]
  );
}

async function recordNameChange(userId, userTag, kind, oldValue, newValue) {
  await query(
    `INSERT INTO name_history (user_id, user_tag, kind, old_value, new_value)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, userTag, kind, oldValue, newValue]
  );
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
    `SELECT DISTINCT ON (channel_id) channel_id, content, created_at
     FROM messages
     WHERE author_id = $1 AND channel_id = ANY($2) AND channel_id <> $3 AND deleted_at IS NULL
     ORDER BY channel_id, created_at DESC NULLS LAST`,
    [userId, channelIds, excludeChannelId]
  );
  return rows;
}

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

module.exports = {
  pool,
  init,
  upsertMessage,
  setReactions,
  archiveMessageJson,
  pruneMessagesInChannels,
  pruneMessagesNotInChannels,
  getMessage,
  getMessages,
  getStandingAdvert,
  getLastDeletedAdvert,
  getStandingAdvertsInChannels,
  updateContent,
  markDeleted,
  getMemberState,
  seedMemberState,
  setMemberState,
  recordNickname,
  recordRoleChange,
  getNicknameHistory,
  getRoleHistory,
  getGuildSettings,
  setGuildSettings,
  getUserState,
  seedUserState,
  setUserState,
  recordNameChange,
  getFlaggedPosts,
  flagPost,
  clearFlaggedPosts,
  clearResolvedFlaggedPosts,
};
