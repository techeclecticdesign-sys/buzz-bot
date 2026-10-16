const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TTL_MS,
  rememberBotDelete,
  forgetBotDelete,
  consumeBotDelete,
  _attributions,
  _normalizeReason,
} = require('./botDeleteAttribution');

test.beforeEach(() => _attributions.clear());
test.afterEach(() => _attributions.clear());

test('remembers and consumes a bot delete reason once', () => {
  rememberBotDelete('123', 'Dead link', 1000);

  assert.deepEqual(consumeBotDelete('123', 1001), { reason: 'Dead link' });
  assert.equal(consumeBotDelete('123', 1002), null);
});

test('normalizes reasons to one embed-friendly line', () => {
  assert.equal(_normalizeReason('  Dead\n\nlink\t'), 'Dead link');
});

test('forgets failed deletes and prunes stale attribution', () => {
  rememberBotDelete('failed', 'Dead link', 1000);
  forgetBotDelete('failed');
  assert.equal(consumeBotDelete('failed', 1001), null);

  rememberBotDelete('stale', 'Dead link', 1000);
  assert.equal(consumeBotDelete('stale', 1000 + TTL_MS + 1), null);
});
