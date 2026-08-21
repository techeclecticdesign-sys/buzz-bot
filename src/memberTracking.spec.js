const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { memberRoleIds, queueMemberChange } = require('./memberTracking');
const db = require('./db');

// memberTracking pulls in db (via itself + embeds), which constructs a pg Pool.
// Close it so the test process exits; nothing here ever connects.
after(() => db.pool.end());

// Build a fake member whose roles.cache is a Map keyed by role id, like discord.js.
function fakeMember(guildId, roleIds) {
  return {
    guild: { id: guildId },
    roles: { cache: new Map(roleIds.map((id) => [id, { id }])) },
  };
}

test('memberRoleIds drops @everyone (== guild id) and sorts', () => {
  const member = fakeMember('G', ['G', 'beta', 'alpha']);
  assert.deepEqual(memberRoleIds(member), ['alpha', 'beta']);
});

test('memberRoleIds: order-independent so two states compare equal', () => {
  const a = memberRoleIds(fakeMember('G', ['x', 'y', 'z']));
  const b = memberRoleIds(fakeMember('G', ['z', 'x', 'y']));
  assert.deepEqual(a, b);
});

test('memberRoleIds: a member with only @everyone yields an empty list', () => {
  assert.deepEqual(memberRoleIds(fakeMember('G', ['G'])), []);
});

test('queueMemberChange serializes work per key in FIFO order', async () => {
  const order = [];
  const step = (label, ms) => () =>
    new Promise((resolve) => setTimeout(() => { order.push(label); resolve(); }, ms));

  // Same key: the second must wait for the first even though it resolves faster.
  const p1 = queueMemberChange('same', step('first', 30));
  const p2 = queueMemberChange('same', step('second', 1));
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ['first', 'second']);
});

test('queueMemberChange: a rejection does not wedge the chain', async () => {
  await assert.rejects(queueMemberChange('k', () => Promise.reject(new Error('boom'))));
  // the next task on the same key still runs
  let ran = false;
  await queueMemberChange('k', async () => { ran = true; });
  assert.equal(ran, true);
});
