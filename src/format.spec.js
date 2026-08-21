const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DESC_MAX, truncate, splitTruncate, attachmentList, fitLines } = require('./format');

test('DESC_MAX stays safely under Discord’s 4096 description cap', () => {
  assert.ok(DESC_MAX < 4096);
  assert.equal(DESC_MAX, 4000);
});

test('truncate: short strings pass through, long ones get an ellipsis', () => {
  assert.equal(truncate('', 5), '');
  assert.equal(truncate(null, 5), null);
  assert.equal(truncate('hello', 10), 'hello');
  assert.equal(truncate('hello', 5), 'hello'); // exactly at max, untouched
  const out = truncate('hello world', 5);
  assert.equal(out, 'hell…');
  assert.equal(out.length, 5); // never exceeds max
});

test('splitTruncate: both sides fit → returned unchanged', () => {
  assert.deepEqual(splitTruncate('abc', 'de', 100), ['abc', 'de']);
});

test('splitTruncate: a short side is never cut to match a long side', () => {
  const [before, after] = splitTruncate('short', 'x'.repeat(1000), 100);
  assert.equal(before, 'short'); // the small side is preserved whole
  assert.ok(after.length <= 100 - 'short'.length);
  assert.ok(before.length + after.length <= 100);
});

test('splitTruncate: two oversized sides split the budget roughly evenly', () => {
  const budget = 100;
  const [before, after] = splitTruncate('a'.repeat(500), 'b'.repeat(500), budget);
  assert.ok(before.length + after.length <= budget);
  assert.ok(before.length >= 40 && after.length >= 40); // neither starved
});

test('splitTruncate: non-positive budget yields empty strings', () => {
  assert.deepEqual(splitTruncate('a', 'b', 0), ['', '']);
  assert.deepEqual(splitTruncate('a', 'b', -5), ['', '']);
});

test('attachmentList: empty/nullish → null', () => {
  assert.equal(attachmentList(null), null);
  assert.equal(attachmentList([]), null);
});

test('attachmentList: renders markdown links, one per line', () => {
  const out = attachmentList([
    { name: 'a.png', url: 'https://cdn/a' },
    { name: 'b.png', url: 'https://cdn/b' },
  ]);
  assert.equal(out, '[a.png](https://cdn/a)\n[b.png](https://cdn/b)');
});

test('attachmentList: overflow stops at a whole line and marks truncation', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({
    name: `file-${i}.png`,
    url: 'https://cdn/' + 'x'.repeat(40),
  }));
  const out = attachmentList(many);
  assert.ok(out.length <= 1024);
  assert.ok(out.endsWith('…'));
  assert.ok(!out.includes('](\n')); // a markdown link was never cut mid-way
});

test('fitLines: everything fits → all lines joined oldest-first', () => {
  assert.equal(fitLines(['a', 'b', 'c']), 'a\nb\nc');
  assert.equal(fitLines([]), '');
});

test('fitLines: over budget drops the OLDEST and notes how many', () => {
  const lines = Array.from({ length: 50 }, (_, i) => `line ${i} ` + 'x'.repeat(200));
  const out = fitLines(lines, 500);
  assert.ok(out.length <= 500 + 60); // budget plus the "…N older" notice
  assert.match(out.split('\n')[0], /older entries not shown/);
  assert.ok(out.includes('line 49')); // newest is always kept
  assert.ok(!out.includes('line 0 ')); // oldest is dropped
});
