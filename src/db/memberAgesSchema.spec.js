const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { initMemberAges } = require('./memberAgesSchema');
const { pool } = require('./pool');
const { setMemberAge, setMemberAges, deleteMemberState, pruneDepartedMemberState } = require('./memberState');
const { pruneDepartedUserState } = require('./userState');
after(() => pool.end());

test('age migration, monotonic updates, and existing member cleanup operate on the same persisted row', async (t) => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(`CREATE TABLE member_state (user_id TEXT PRIMARY KEY, user_tag TEXT,
    nickname TEXT, display_name TEXT, role_ids TEXT[] DEFAULT '{}', updated_at TIMESTAMPTZ);
    INSERT INTO member_state (user_id, user_tag) VALUES ('a', 'member-a'), ('b', 'member-b');`);
  await initMemberAges((sql) => db.exec(sql));
  await initMemberAges((sql) => db.exec(sql));
  t.mock.method(pool, 'query', async (sql, params) => {
    const result = await db.query(sql, params);
    return { ...result, rowCount: result.affectedRows };
  });
  const row = async (id) => (await db.query('SELECT * FROM member_state WHERE user_id = $1', [id])).rows[0];
  assert.equal((await row('a')).age_stated, null);
  await setMemberAge('a', 19, '2025-05-05T12:00:00Z', '200');
  await setMemberAge('a', 18, '2024-05-05T12:00:00Z', '100');
  assert.equal((await row('a')).age_stated, 19);
  assert.equal(new Date((await row('a')).age_stated_at).toISOString(), '2025-05-05T12:00:00.000Z');
  await setMemberAge('a', 20, '2026-05-05T12:00:00Z', '300');
  assert.equal((await row('a')).age_stated, 20);
  await assert.rejects(db.query("UPDATE member_state SET age_stated = 14 WHERE user_id = 'a'"), { code: '23514' });
  await setMemberAges([
    { user_id: 'a', user_tag: 'stale-name', role_ids: ['stale-role'], age_stated: 18,
      age_stated_at: '2024-05-05T12:00:00Z', age_message_id: '100' },
    { user_id: 'c', user_tag: 'member-c', role_ids: [], age_stated: 17,
      age_stated_at: '2025-05-05T12:00:00Z', age_message_id: '200' },
  ]);
  assert.equal((await row('a')).age_stated, 20);
  assert.equal((await row('a')).user_tag, 'member-a');
  assert.equal((await row('c')).age_stated, 17);
  await deleteMemberState('a');
  await setMemberAge('a', 19, '2027-05-05T12:00:00Z', '401');
  assert.equal(await row('a'), undefined);
  await setMemberAge('b', 17, '2025-05-05T12:00:00Z', '500');
  // A full roster is a snapshot. Do not delete members whose join was persisted
  // after the snapshot began, even if they were not included in that response.
  await db.exec(`UPDATE member_state SET updated_at = '2025-01-01' WHERE user_id = 'b';
    UPDATE member_state SET updated_at = '2023-01-01' WHERE user_id = 'c';
    CREATE TABLE user_state (user_id TEXT PRIMARY KEY, updated_at TIMESTAMPTZ);
    INSERT INTO user_state VALUES ('b', '2025-01-01'), ('c', '2023-01-01');`);
  await pruneDepartedMemberState([], '2024-01-01');
  await pruneDepartedUserState([], '2024-01-01');
  assert.equal((await row('b')).age_stated, 17);
  assert.equal(await row('c'), undefined);
  assert.deepEqual((await db.query('SELECT user_id FROM user_state')).rows, [{ user_id: 'b' }]);
  await pruneDepartedMemberState(['a']);
  assert.equal(await row('b'), undefined);
  await pruneDepartedUserState([]);
  assert.equal((await db.query('SELECT * FROM user_state')).rows.length, 0);
});
