// Schema + in-place migrations. Each block creates the current schema on a fresh
// DB and migrates an existing one. Runs once at boot via init().
const { pool } = require('./pool');

async function init() {
  // Single-server bot, so tables carry no guild_id. Only GROUP advert images are
  // stored (group_advert_images, for the browse site); other attachments aren't.
  // DROP COLUMN doesn't reclaim disk — run VACUUM FULL (or let autovacuum) after.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      channel_id  TEXT NOT NULL,
      author_id   TEXT,
      author_tag  TEXT,
      content     TEXT,
      created_at  TIMESTAMPTZ,
      edited_at   TIMESTAMPTZ,
      deleted_at  TIMESTAMPTZ,
      -- Image-attachment metadata for GROUP adverts only (array of
      -- { pos, filename, contentType, width, height, size }; NULL otherwise).
      -- The bytes live in group_advert_images. NULL for every non-group post.
      attachments JSONB
    );
  `);
  // guild_id is not part of the messages PK, so it drops cleanly in place.
  await pool.query('ALTER TABLE messages DROP COLUMN IF EXISTS guild_id;');
  // Reaction summary for advert posts (only advert channels are populated). Each
  // element is { id, name, animated, count }; NULL means no reactions. Kept live
  // by the reaction handlers and (re)seeded by backfill from the fetched message.
  await pool.query('ALTER TABLE messages ADD COLUMN IF NOT EXISTS reactions JSONB;');
  await pool.query(
    'CREATE INDEX IF NOT EXISTS messages_channel_idx ON messages (channel_id);'
  );
  // Group-advert image bytes, one row per image, kept out of the wide messages
  // table. Bytes not the Discord CDN url (which is signed and expires). FK
  // ON DELETE CASCADE reclaims them when the message row is pruned.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS group_advert_images (
      message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      pos          INT  NOT NULL,
      channel_id   TEXT NOT NULL,
      image        BYTEA NOT NULL,
      content_type TEXT NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (message_id, pos)
    );
  `);
  // Speeds the daily retention prune (created_at < cutoff) and the advert
  // cleanup's age query.
  await pool.query(
    'CREATE INDEX IF NOT EXISTS messages_created_idx ON messages (created_at);'
  );

  // Link-check grace clock: the daily sweep stamps a violating post here (keyed
  // by reason: dead invite / duplicate server); once past LINK_CHECK_GRACE_HOURS
  // and still violating, it's deleted. Persisted so the clock survives restarts;
  // rows clear when the post is fixed or deleted.
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
  // Migration: fold legacy dead_link_posts into flagged_posts, then drop it.
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

  // Last-known nickname + roles per member. Change detection diffs against this
  // (the event's oldMember is empty for uncached members after a restart).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS member_state (
      user_id    TEXT PRIMARY KEY,
      user_tag   TEXT,
      nickname   TEXT,
      role_ids   TEXT[] NOT NULL DEFAULT '{}',
      updated_at TIMESTAMPTZ
    );
  `);
  // Migration: drop guild_id (was half the PK) and re-key on user_id. Guarded on
  // guild_id existing, so it no-ops after the first run.
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
  // display_name = what Discord renders (nickname ?? globalName ?? username);
  // nickname alone is NULL for members without a server nick.
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
  // Dropping guild_id drops its dependent index; recreated on user_id below.
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

  // Logging prefs (toggled via >>settings), one row keyed on a constant id.
  // log_to_channel is the master switch: off pauses log-channel output while the
  // DB archive keeps running (default off). log_role_changes is opt-in; edits,
  // deletes and name changes are always logged when posting is on.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS guild_settings (
      id               INT PRIMARY KEY DEFAULT 1,
      log_role_changes BOOLEAN NOT NULL DEFAULT false,
      log_to_channel   BOOLEAN NOT NULL DEFAULT false,
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Add log_to_channel to older DBs (default off).
  await pool.query(
    'ALTER TABLE guild_settings ADD COLUMN IF NOT EXISTS log_to_channel BOOLEAN NOT NULL DEFAULT false;'
  );
  // Migration: collapse a guild_id-keyed table to the single row keyed id = 1.
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

  // Last-known account-level names per user, for detecting username/display-name
  // changes (userUpdate's oldUser is empty for uncached users, like member_state).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_state (
      user_id     TEXT PRIMARY KEY,
      username    TEXT,
      global_name TEXT,
      updated_at  TIMESTAMPTZ
    );
  `);

  // Append-only history of account-level (global) name changes; per-guild
  // nicknames live in nickname_history.
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

  // One outstanding advisory per post; also the re-check queue. Holds the
  // #rule_infractions ping id, the post's channel, and the next re-check time.
  // Read by: bump (a re-trip deletes the old ping and posts a fresh one, so the
  // channel shows one advisory) and the re-check poll (clean → clear
  // :staffpending: + mark ping :staffapproved:; still broken at the terminal
  // stage → remove the post). Row deleted once resolved. Persisted across restarts.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS advert_infractions (
      advert_id     TEXT PRIMARY KEY,
      advisory_id   TEXT NOT NULL,
      channel_id    TEXT,
      stage         INT NOT NULL DEFAULT 1,
      next_check_at TIMESTAMPTZ,
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // Add the re-check columns to older DBs.
  await pool.query('ALTER TABLE advert_infractions ADD COLUMN IF NOT EXISTS channel_id TEXT;');
  await pool.query('ALTER TABLE advert_infractions ADD COLUMN IF NOT EXISTS stage INT NOT NULL DEFAULT 1;');
  await pool.query('ALTER TABLE advert_infractions ADD COLUMN IF NOT EXISTS next_check_at TIMESTAMPTZ;');
  // The re-check sweep queries by due time.
  await pool.query(
    'CREATE INDEX IF NOT EXISTS advert_infractions_due_idx ON advert_infractions (next_check_at);'
  );

  // Ledger of the #rule_infractions pings this bot posts, so infractionExpiry.js
  // can age them out (YAGPDB's own expiry sweep skips bot messages). Copycat
  // stickies aren't recorded here. One row per ping; rows clear as pings expire.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS infraction_posts (
      message_id TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      posted_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(
    'CREATE INDEX IF NOT EXISTS infraction_posts_posted_idx ON infraction_posts (posted_at);'
  );
}

module.exports = { init };
