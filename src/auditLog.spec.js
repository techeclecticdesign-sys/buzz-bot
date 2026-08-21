const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { rememberAuditCount, AUDIT_COUNTS_CAP, _auditCounts } = require('./auditLog');

// The LRU bounds unbounded growth of the per-audit-entry counters while never
// evicting an entry that's still being incremented (a mod repeatedly deleting
// the same user/channel). This module holds no I/O, so it tests in isolation.

beforeEach(() => _auditCounts.clear());

test('stores and updates a counter by id', () => {
  rememberAuditCount('a', 1);
  assert.equal(_auditCounts.get('a'), 1);
  rememberAuditCount('a', 3);
  assert.equal(_auditCounts.get('a'), 3);
  assert.equal(_auditCounts.size, 1); // update, not a second entry
});

test('caps the map at AUDIT_COUNTS_CAP, evicting the oldest first', () => {
  for (let i = 0; i < AUDIT_COUNTS_CAP + 5; i++) rememberAuditCount(`k${i}`, i);
  assert.equal(_auditCounts.size, AUDIT_COUNTS_CAP);
  // the five earliest keys were evicted
  for (let i = 0; i < 5; i++) assert.equal(_auditCounts.has(`k${i}`), false);
  assert.equal(_auditCounts.has('k5'), true);
  assert.equal(_auditCounts.has(`k${AUDIT_COUNTS_CAP + 4}`), true);
});

test('re-touching a key moves it to the back, sparing it from eviction', () => {
  for (let i = 0; i < AUDIT_COUNTS_CAP; i++) rememberAuditCount(`k${i}`, i); // full
  rememberAuditCount('k0', 99); // still-active entry — must survive
  rememberAuditCount('new', 1); // pushes size over the cap → one eviction
  assert.equal(_auditCounts.size, AUDIT_COUNTS_CAP);
  assert.equal(_auditCounts.get('k0'), 99); // spared because it was re-touched
  assert.equal(_auditCounts.has('k1'), false); // the new oldest was evicted
  assert.equal(_auditCounts.has('new'), true);
});
