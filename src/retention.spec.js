const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const retention = require('./retention');
const advertConfig = require('./advertConfig');
const db = require('./db');

// Requiring retention pulls in db, which constructs a pg Pool. Close it so the
// test process exits (it never connects — we only read a computed constant).
after(() => db.pool.end());

const maxLockoutHours = Math.max(
  0,
  ...Object.values(advertConfig.TYPES).map((t) => t.lockoutHours || 0),
);

test('deleted-row purge window covers the longest advert repost cooldown', () => {
  // The failsafe reads deleted advert rows for up to maxLockoutHours after they
  // were posted; purging sooner would let a delete+repost bypass the cooldown.
  assert.ok(
    retention.deletedKeepDays * 24 >= maxLockoutHours,
    `deletedKeepDays (${retention.deletedKeepDays}d) must cover max lockout (${maxLockoutHours}h)`,
  );
});

test('default deleted-row window is the expected 8 days (7-day lockout + 1)', () => {
  // Concrete lock-in for the current config. If the advert lockout changes, this
  // is meant to fail so the retention window is reconsidered deliberately.
  assert.equal(maxLockoutHours, 168);
  assert.equal(retention.deletedKeepDays, 8);
});
