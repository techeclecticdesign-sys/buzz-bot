// Account-level username / display-name tracking (user_state, name_history).
const { query } = require('./pool');

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

// Departed users: same reasoning as deleteMemberState / pruneDepartedMemberState.
async function deleteUserState(userId) {
  await query('DELETE FROM user_state WHERE user_id = $1', [userId]);
}

async function pruneDepartedUserState(presentIds) {
  const res = await query(
    'DELETE FROM user_state WHERE NOT (user_id = ANY($1::text[]))',
    [presentIds]
  );
  return res.rowCount;
}

async function recordNameChange(userId, userTag, kind, oldValue, newValue) {
  await query(
    `INSERT INTO name_history (user_id, user_tag, kind, old_value, new_value)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, userTag, kind, oldValue, newValue]
  );
}

module.exports = {
  getUserState,
  seedUserState,
  setUserState,
  deleteUserState,
  pruneDepartedUserState,
  recordNameChange,
};
