// Per-guild logging preferences (guild_settings, single row).
const { query } = require('./pool');

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

module.exports = {
  getGuildSettings,
  setGuildSettings,
};
