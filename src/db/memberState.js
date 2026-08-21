// Member nickname + role tracking (member_state, nickname_history, role_history).
const { query } = require('./pool');

// --- Member state (nickname + role tracking) ---

async function getMemberState(userId) {
  const { rows } = await query(
    'SELECT * FROM member_state WHERE user_id = $1',
    [userId]
  );
  return rows[0] ?? null;
}

// Insert a baseline for a member we've never seen; never clobbers existing state
// (priming on startup / join). Exception: a NULL display_name is backfilled.
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

module.exports = {
  getMemberState,
  seedMemberState,
  setMemberState,
  recordNickname,
  recordRoleChange,
  getNicknameHistory,
  getRoleHistory,
};
