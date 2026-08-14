const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isImage, imageSignature, fromDiscordMessage } = require('./advertImages');

// Build a fake discord.js message: `.attachments` just needs `.values()`, so a
// Map does the job. Each attachment mirrors the fields fromDiscordMessage reads.
function fakeMessage(attachments) {
  return { attachments: new Map(attachments.map((a, i) => [String(i), a])) };
}
const att = (over = {}) => ({
  contentType: 'image/png',
  name: 'a.png',
  url: 'https://cdn/x',
  width: 100,
  height: 80,
  size: 1234,
  ...over,
});

test('isImage: keeps raster images by content-type', () => {
  assert.equal(isImage('image/png', 'a.png'), true);
  assert.equal(isImage('image/jpeg', 'a.jpg'), true);
  assert.equal(isImage('image/gif', 'a.gif'), true);
  assert.equal(isImage('image/webp', 'a.webp'), true);
});

test('isImage: excludes SVG (active content — XSS risk)', () => {
  assert.equal(isImage('image/svg+xml', 'a.svg'), false);
  assert.equal(isImage('image/svg+xml', 'a.png'), false); // type wins
});

test('isImage: falls back to extension when content-type is missing', () => {
  assert.equal(isImage(null, 'photo.JPG'), true); // case-insensitive
  assert.equal(isImage(undefined, 'clip.gif'), true);
  assert.equal(isImage('', 'notes.txt'), false);
  assert.equal(isImage(null, null), false);
});

test('isImage: rejects non-image content-types', () => {
  assert.equal(isImage('application/pdf', 'a.pdf'), false);
  assert.equal(isImage('text/html', 'a.html'), false);
});

test('imageSignature: order-independent, equal for the same set', () => {
  const a = imageSignature([{ filename: 'a.png' }, { filename: 'b.png' }]);
  const b = imageSignature([{ filename: 'b.png' }, { filename: 'a.png' }]);
  assert.equal(a, b);
});

test('imageSignature: differs on add / remove / rename', () => {
  const base = imageSignature([{ filename: 'a.png' }, { filename: 'b.png' }]);
  assert.notEqual(base, imageSignature([{ filename: 'a.png' }])); // removed
  assert.notEqual(
    base,
    imageSignature([{ filename: 'a.png' }, { filename: 'b.png' }, { filename: 'c.png' }]),
  ); // added
  assert.notEqual(base, imageSignature([{ filename: 'a.png' }, { filename: 'z.png' }])); // renamed
});

test('imageSignature: empty list and null are equal (no images either way)', () => {
  assert.equal(imageSignature([]), imageSignature(null));
  assert.equal(imageSignature([]), imageSignature(undefined));
});

test('imageSignature: filenames with spaces do not alias', () => {
  const a = imageSignature([{ filename: 'a b.png' }, { filename: 'c.png' }]);
  const b = imageSignature([{ filename: 'a.png' }, { filename: 'b c.png' }]);
  assert.notEqual(a, b);
});

test('fromDiscordMessage: keeps only images, contiguous pos, mapped fields', () => {
  const msg = fakeMessage([
    att({ name: 'first.png' }),
    att({ contentType: 'application/pdf', name: 'doc.pdf' }), // dropped
    att({ contentType: 'image/svg+xml', name: 'evil.svg' }), // dropped
    att({ name: 'third.jpg', contentType: 'image/jpeg', width: 50, height: 40 }),
  ]);
  const out = fromDiscordMessage(msg);
  assert.equal(out.length, 2);
  assert.deepEqual(
    out.map((d) => d.pos),
    [0, 1],
  );
  assert.equal(out[0].filename, 'first.png');
  assert.equal(out[1].filename, 'third.jpg');
  assert.equal(out[1].contentType, 'image/jpeg');
  assert.equal(out[1].width, 50);
});

test('fromDiscordMessage: defaults a missing content-type to octet-stream', () => {
  const msg = fakeMessage([att({ contentType: null, name: 'pic.png' })]);
  const out = fromDiscordMessage(msg);
  assert.equal(out.length, 1); // matched by extension
  assert.equal(out[0].contentType, 'application/octet-stream');
});
