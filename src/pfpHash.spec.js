const { test } = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { MIN_DETAIL, phash, hamming, nearest } = require('./pfpHash');

// A detailed synthetic "avatar": coloured shapes on a gradient, drawn as SVG.
function avatar(shapes, size = 1024) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 100 100">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#203060"/><stop offset="1" stop-color="#e0a040"/></linearGradient></defs>
    <rect width="100" height="100" fill="url(#g)"/>${shapes}</svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}
const FACE = '<circle cx="50" cy="40" r="22" fill="#f5d0b0"/><rect x="20" y="66" width="60" height="34" fill="#a02030"/>';
const LOGO = '<rect x="10" y="10" width="35" height="80" fill="#10c060"/><circle cx="72" cy="70" r="18" fill="#ffffff"/>';

test('the same picture at another size and format matches', async () => {
  const big = await avatar(FACE);
  const small = await sharp(big).resize(128, 128).webp({ quality: 80 }).toBuffer();
  const a = await phash(big);
  const b = await phash(small);
  assert.ok(hamming(a.hash, b.hash) <= 4, `distance ${hamming(a.hash, b.hash)}`);
});

test('different pictures are far apart', async () => {
  const a = await phash(await avatar(FACE));
  const b = await phash(await avatar(LOGO));
  assert.ok(hamming(a.hash, b.hash) > 14, `distance ${hamming(a.hash, b.hash)}`);
});

test('a solid colour is too plain to ban', async () => {
  const solid = await sharp({ create: { width: 256, height: 256, channels: 3, background: '#3366cc' } }).png().toBuffer();
  assert.ok((await phash(solid)).detail < MIN_DETAIL);
  assert.ok((await phash(await avatar(FACE))).detail >= MIN_DETAIL);
});

test('transparent pixels hash as white', async () => {
  const clear = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
  const white = await sharp({ create: { width: 64, height: 64, channels: 3, background: '#ffffff' } }).png().toBuffer();
  assert.equal((await phash(clear)).hash, (await phash(white)).hash);
});

test('hamming counts differing bits', () => {
  assert.equal(hamming('0000000000000000', '0000000000000000'), 0);
  assert.equal(hamming('ffffffffffffffff', '0000000000000000'), 64);
  assert.equal(hamming('8000000000000001', '0000000000000000'), 2);
});

test('nearest picks the closest row', () => {
  const rows = [{ id: 1, phash: 'ffff000000000000' }, { id: 2, phash: '0000000000000003' }];
  const best = nearest('0000000000000001', rows);
  assert.equal(best.row.id, 2);
  assert.equal(best.distance, 1);
  assert.equal(nearest('0000000000000001', []), null);
});
