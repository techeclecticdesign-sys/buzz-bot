const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { isImage, imageSignature, fromDiscordMessage, shrinkImage, MAX_DIMENSION } = require('./advertImages');

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

// A noisy RGB PNG: realistic enough that WebP beats it.
async function noisyPng(width, height) {
  const raw = Buffer.alloc(width * height * 3);
  let x = 2463534242; // xorshift: noise PNG can't compress
  for (let i = 0; i < raw.length; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    raw[i] = x & 0xff;
  }
  return sharp(raw, { raw: { width, height, channels: 3 } }).png().toBuffer();
}

test('shrinkImage: scales a large image to fit and stores it as WebP', async () => {
  const buffer = await noisyPng(3000, 1500);
  const out = await shrinkImage({ pos: 0, filename: 'banner.png', contentType: 'image/png', width: 3000, height: 1500, buffer });
  assert.equal(out.contentType, 'image/webp');
  assert.equal(out.width, MAX_DIMENSION);
  assert.equal(out.height, 1024);
  assert.equal(out.size, out.buffer.length);
  assert.ok(out.buffer.length < buffer.length);
  assert.equal(out.filename, 'banner.png'); // imageSignature compares filenames
  assert.equal((await sharp(out.buffer).metadata()).format, 'webp');
});

test("shrinkImage: keeps an animation's frames and per-frame height", async () => {
  const frame = (r) => sharp({ create: { width: 40, height: 30, channels: 3, background: { r, g: 0, b: 0 } } }).raw().toBuffer();
  const frames = await Promise.all([frame(255), frame(0), frame(128)]);
  const gif = await sharp(Buffer.concat(frames), { raw: { width: 40, height: 90, channels: 3, pageHeight: 30 } })
    .gif()
    .toBuffer();
  const out = await shrinkImage({ pos: 0, filename: 'a.gif', contentType: 'image/gif', buffer: gif });
  if (out.buffer === gif) return; // already smaller than its WebP: kept as it is
  assert.equal(out.width, 40);
  assert.equal(out.height, 30);
  assert.equal((await sharp(out.buffer, { animated: true }).metadata()).pages, 3);
});

test('shrinkImage: keeps the original when it cannot be read', async () => {
  const img = { pos: 0, filename: 'x.png', contentType: 'image/png', buffer: Buffer.from('not an image') };
  assert.equal(await shrinkImage(img), img);
});
