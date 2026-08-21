const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { bool, flag, num, idList, MANIFEST } = require('./config');

// The parsers read process.env at call time, so set/restore a scratch key per test.
const KEY = '__CONFIG_SPEC__';
afterEach(() => delete process.env[KEY]);
const set = (v) => { if (v === undefined) delete process.env[KEY]; else process.env[KEY] = v; };

test('bool: unset/empty → default; only the literal "false" turns it off', () => {
  set(undefined); assert.equal(bool(KEY, true), true);
  set(undefined); assert.equal(bool(KEY, false), false);
  set(''); assert.equal(bool(KEY, true), true);
  set('false'); assert.equal(bool(KEY, true), false);
  set('true'); assert.equal(bool(KEY, true), true);
  set('anything'); assert.equal(bool(KEY, true), true); // matches old `!== 'false'`
});

test('flag: strict — only "true" enables it', () => {
  set(undefined); assert.equal(flag(KEY), false);
  set('true'); assert.equal(flag(KEY), true);
  set('false'); assert.equal(flag(KEY), false);
  set('1'); assert.equal(flag(KEY), false); // matches old `=== 'true'`
});

test('num: Number(x) || default (0 and non-numeric fall back), then clamp', () => {
  set(undefined); assert.equal(num(KEY, 365), 365);
  set(''); assert.equal(num(KEY, 365), 365);
  set('abc'); assert.equal(num(KEY, 365), 365);
  set('0'); assert.equal(num(KEY, 365), 365); // the documented || quirk: 0 → default
  set('400'); assert.equal(num(KEY, 365), 400);
  set('-3'); assert.equal(num(KEY, 365, { min: 1 }), 1); // min clamp
  set('999'); assert.equal(num(KEY, 4, { min: 0, max: 23 }), 23); // max clamp
  set('12'); assert.equal(num(KEY, 4, { min: 0, max: 23 }), 12);
});

test('idList: comma split, trimmed, empties dropped', () => {
  set(undefined); assert.deepEqual(idList(KEY), []);
  set(''); assert.deepEqual(idList(KEY), []);
  set('a'); assert.deepEqual(idList(KEY), ['a']);
  set(' a , b ,,c '); assert.deepEqual(idList(KEY), ['a', 'b', 'c']);
});

test('MANIFEST: every entry has a name + kind, no duplicate names', () => {
  const names = MANIFEST.map((e) => e.name);
  for (const e of MANIFEST) {
    assert.ok(e.name, 'entry missing name');
    assert.ok(e.kind, `${e.name} missing kind`);
  }
  assert.equal(names.length, new Set(names).size, 'duplicate env var in MANIFEST');
});

test('MANIFEST: the hard-required vars are marked', () => {
  const required = MANIFEST.filter((e) => e.req === true).map((e) => e.name).sort();
  assert.deepEqual(required, ['DATABASE_URL', 'DISCORD_TOKEN']);
});
