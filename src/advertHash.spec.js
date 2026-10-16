const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeAdvertText, advertContentHash } = require('./advertHash');

// This hash is the matching key shared across three codebases (this bot, rpc-web,
// and the one-time seed script). The PINNED vector below must be identical in
// rpc-web's lib/advertHash.test.ts — if either side changes the normalization or
// digest, these asserts diverge and catch the drift before it ships.
const PINNED_INPUT = '  Hello   world\n\tfoo  ';
const PINNED_NORMALIZED = 'Hello world foo';
const PINNED_SHA256 = '80c6e6a57b39ae7e651729af1455d058f8c791f5ec0eefd95e2bc4db29a81244';

test('normalizeAdvertText collapses whitespace runs and trims', () => {
  assert.equal(normalizeAdvertText(PINNED_INPUT), PINNED_NORMALIZED);
  assert.equal(normalizeAdvertText('a\n\nb'), 'a b');
  assert.equal(normalizeAdvertText('  spaced  out  '), 'spaced out');
});

test('normalizeAdvertText returns empty string for blank / non-string input', () => {
  assert.equal(normalizeAdvertText(''), '');
  assert.equal(normalizeAdvertText('   \n\t '), '');
  assert.equal(normalizeAdvertText(null), '');
  assert.equal(normalizeAdvertText(undefined), '');
});

test('advertContentHash matches the pinned cross-repo vector', () => {
  assert.equal(advertContentHash(PINNED_INPUT), PINNED_SHA256);
});

test('advertContentHash is null when there is no text to match on', () => {
  assert.equal(advertContentHash(''), null);
  assert.equal(advertContentHash('   \n '), null);
  assert.equal(advertContentHash(null), null);
});

test('advertContentHash ignores formatting-only differences', () => {
  // Same words, different whitespace → same hash (a reformatted repost matches).
  assert.equal(advertContentHash('Hello world foo'), advertContentHash(PINNED_INPUT));
});

test('advertContentHash distinguishes different text', () => {
  assert.notEqual(advertContentHash('Hello world foo'), advertContentHash('Hello world bar'));
});
