const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  runeLength,
  wordCount,
  bannedHits,
  headerMatch,
  isHeaderLine,
  hasAnyHeader,
  groupHeaderIssue,
  linkPresent,
  normalizeForDupe,
} = require('./advertChecks');

// These are pure ports of the YAGPDB advert commands and drive destructive
// auto-deletes / advisories, so the tricky rendering rules are locked in here.

test('runeLength counts code points, not UTF-16 units', () => {
  assert.equal(runeLength(''), 0);
  assert.equal(runeLength(null), 0);
  assert.equal(runeLength('abc'), 3);
  assert.equal(runeLength('👍'), 1); // astral char is one rune, not two
  assert.equal(runeLength('a👍b'), 3);
});

test('wordCount splits on whitespace runs and ignores padding', () => {
  assert.equal(wordCount(''), 0);
  assert.equal(wordCount('   '), 0);
  assert.equal(wordCount('one'), 1);
  assert.equal(wordCount('  one   two\tthree \n four '), 4);
});

test('bannedHits: whole-word, case-insensitive, deduped, spoiler-wrapped', () => {
  assert.deepEqual(bannedHits('nothing here', ['futa']), []);
  assert.deepEqual(bannedHits('I like futa', ['futa']), ['||futa||']);
  // case-insensitive match, but the FIRST occurrence's casing is preserved
  assert.deepEqual(bannedHits('futa and FUTA', ['futa']), ['||futa||']);
  // whole-word only: "futanari" must NOT trip the "futa" rule
  assert.deepEqual(bannedHits('futanari lovers', ['futa']), []);
  // multiple distinct banned words each reported once
  assert.deepEqual(
    bannedHits('futa futa futanari', ['futa', 'futanari']),
    ['||futa||', '||futanari||'],
  );
  assert.deepEqual(bannedHits('anything', []), []);
});

test('headerMatch: 1-3 hashes render, 4+ do not', () => {
  assert.deepEqual(headerMatch('# Title'), { level: 1, body: 'Title' });
  assert.deepEqual(headerMatch('## Two'), { level: 2, body: 'Two' });
  assert.deepEqual(headerMatch('### Three'), { level: 3, body: 'Three' });
  assert.equal(headerMatch('#### Four'), null); // 4 hashes render literally
  assert.equal(headerMatch('#notaheader'), null); // needs whitespace after the #
  assert.equal(headerMatch('plain text'), null);
});

test('headerMatch: leading spaces and tabs still render as headers', () => {
  assert.deepEqual(headerMatch('   # Indented'), { level: 1, body: 'Indented' });
  assert.deepEqual(headerMatch('#\tTabbed'), { level: 1, body: 'Tabbed' });
});

test('headerMatch: a bare marker is a header with empty body', () => {
  assert.deepEqual(headerMatch('#'), { level: 1, body: '' });
  assert.deepEqual(headerMatch('  ##  '), { level: 2, body: '' });
});

test('headerMatch: blockquote evasion is defeated (one quote strip)', () => {
  // The real evasion: quoting every header line so a naive startsWith("#") misses it.
  assert.deepEqual(headerMatch('> # Quoted'), { level: 1, body: 'Quoted' });
  assert.deepEqual(headerMatch('>>> ## Triple'), { level: 2, body: 'Triple' });
  assert.deepEqual(headerMatch('>>>### NoSpace'), { level: 3, body: 'NoSpace' });
  assert.equal(isHeaderLine('> # x'), true);
});

test('headerMatch: subtext-marker evasion is defeated (strip -# then #)', () => {
  // "-# ## TITLE" renders the ## as a heading; the "-# " prefix must be stripped.
  assert.deepEqual(headerMatch('-# ## Hidden'), { level: 2, body: 'Hidden' });
  // Combined with a blockquote, as seen in the wild: "> -# ## TITLE".
  assert.deepEqual(headerMatch('> -# ## Hidden'), { level: 2, body: 'Hidden' });
  // A plain subtext line is NOT a header — it loses "-#" and has no leading #.
  assert.equal(headerMatch('-# just small print'), null);
  assert.equal(headerMatch('> -# small print in a quote'), null);
});

test('hasAnyHeader: true if any line renders as a header (1x1 / quick rule)', () => {
  assert.equal(hasAnyHeader('all plain\nlines here'), false);
  assert.equal(hasAnyHeader('intro\n## a heading\nmore'), true);
  assert.equal(hasAnyHeader('> # quoted heading'), true);
  // header hidden behind a subtext marker inside a quote (real evasion)
  assert.equal(hasAnyHeader('body text\n> -# ## sneaky'), true);
  // bare subtext must stay legal (rules doc uses "-#" throughout)
  assert.equal(hasAnyHeader('body text\n-# small print'), false);
});

test('groupHeaderIssue: at most one header, each within its size cap', () => {
  assert.equal(groupHeaderIssue('# just one'), false);
  assert.equal(groupHeaderIssue('no headers at all'), false);
  // two headers breaks the group rule
  assert.equal(groupHeaderIssue('# one\n# two'), true);
  // # cap is 50 runes
  assert.equal(groupHeaderIssue('# ' + 'x'.repeat(50)), false);
  assert.equal(groupHeaderIssue('# ' + 'x'.repeat(51)), true);
  // ## cap is 60, ### cap is 70
  assert.equal(groupHeaderIssue('### ' + 'x'.repeat(70)), false);
  assert.equal(groupHeaderIssue('### ' + 'x'.repeat(71)), true);
});

test('groupHeaderIssue: size cap counts only what RENDERS', () => {
  // masked link shows just its anchor text — the long URL must not count
  assert.equal(groupHeaderIssue('# [short](https://example.com/' + 'a'.repeat(200) + ')'), false);
  // custom emoji collapses to a single glyph
  assert.equal(groupHeaderIssue('# <:bigname:123456789012345678>'), false);
});

test('groupHeaderIssue: a bare marker borrows the next line as its body', () => {
  // "#\nActual Title" renders Actual Title as the heading — one header, in cap
  assert.equal(groupHeaderIssue('#\nActual Title'), false);
  // ...and it still counts as a header, so a second one trips the >1 rule
  assert.equal(groupHeaderIssue('#\nFirst Title\n# Second'), true);
});

test('linkPresent: any http(s) URL', () => {
  assert.equal(linkPresent('no links here'), false);
  assert.equal(linkPresent('visit http://example.com now'), true);
  assert.equal(linkPresent('https://secure.example.com'), true);
  assert.equal(linkPresent(''), false);
});

test('normalizeForDupe: lowercase, drop URLs, strip to [a-z0-9 ], collapse', () => {
  assert.equal(normalizeForDupe('Hello, WORLD!'), 'hello world');
  assert.equal(normalizeForDupe('See   http://x.com/y   here'), 'see here');
  assert.equal(normalizeForDupe('A1  b2\n\nc3'), 'a1 b2 c3');
  assert.equal(normalizeForDupe(''), '');
  // two ads that differ only by URL and punctuation normalize identically
  assert.equal(
    normalizeForDupe('Join my server! https://discord.gg/aaa'),
    normalizeForDupe('join my server https://discord.gg/bbb'),
  );
});
