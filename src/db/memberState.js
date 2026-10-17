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

// Drop a departed member's baseline. Their roles/nickname are gone the moment
// they leave, so a kept row would be a stale baseline on rejoin (seedMemberState
// never overwrites) and the first change after would diff against dead roles.
async function deleteMemberState(userId) {
  await query('DELETE FROM member_state WHERE user_id = $1', [userId]);
}

// A late history page must never replace a more recent live age statement.
// UPDATE only: queued writes cannot resurrect a member after departure cleanup.
async function setMemberAge(userId, age, statedAt, messageId) {
  const result = await query(
    `UPDATE member_state SET age_stated = $2, age_stated_at = $3, age_message_id = $4
      WHERE user_id = $1 AND (age_stated_at IS NULL
        OR (age_stated_at, age_message_id) < ($3::timestamptz, $4::text))`,
    [userId, age, statedAt, messageId]
  );
  return result.rowCount;
}

// One history page at a time; avoid thousands of database round trips during
// the initial backfill. Existing names and roles remain untouched on conflict.
async function setMemberAges(records) {
  if (!records.length) return 0;
  const result = await query(
    `INSERT INTO member_state AS m
       (user_id, user_tag, nickname, display_name, role_ids, updated_at,
        age_stated, age_stated_at, age_message_id)
     SELECT user_id, user_tag, nickname, display_name, role_ids, now(),
            age_stated, age_stated_at, age_message_id
       FROM jsonb_to_recordset($1::jsonb) AS x(user_id text, user_tag text,
         nickname text, display_name text, role_ids text[], age_stated int,
         age_stated_at timestamptz, age_message_id text)
     ON CONFLICT (user_id) DO UPDATE
       SET age_stated = EXCLUDED.age_stated, age_stated_at = EXCLUDED.age_stated_at,
           age_message_id = EXCLUDED.age_message_id
       WHERE m.age_stated_at IS NULL
          OR (m.age_stated_at, m.age_message_id) < (EXCLUDED.age_stated_at, EXCLUDED.age_message_id)`,
    [JSON.stringify(records)]
  );
  return result.rowCount;
}

// Drop baselines for everyone not in `presentIds` (the full member list). Catches
// departures that happened while the bot was offline. Returns rows removed.
// A cutoff protects joins that occurred while the roster fetch was in flight.
async function pruneDepartedMemberState(presentIds, before = null) {
  const res = await query(
    `DELETE FROM member_state WHERE NOT (user_id = ANY($1::text[]))
      AND ($2::timestamptz IS NULL OR updated_at < $2 OR updated_at IS NULL)`,
    [presentIds, before]
  );
  return res.rowCount;
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
  deleteMemberState,
  setMemberAge,
  setMemberAges,
  pruneDepartedMemberState,
  recordNickname,
  recordRoleChange,
  getNicknameHistory,
  getRoleHistory,
};
