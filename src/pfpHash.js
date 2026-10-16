// Perceptual hash for profile pictures. Two copies of one picture hash within a
// few bits of each other even when Discord serves them at different sizes or
// formats (the enlarged webp a moderator downloads vs. the png the bot fetches),
// so matching is by Hamming distance, not byte equality.
const sharp = require('sharp');

const SIZE = 32; // DCT input is SIZE x SIZE greyscale
const LOW = 8; // keep the LOW x LOW lowest frequencies → 64-bit hash

// A plain image (solid colour, faint gradient) has almost no low-frequency
// structure, so unrelated plain pictures hash alike. Below this greyscale
// standard deviation an image is too plain to ban or match on.
const MIN_DETAIL = 10;

// cos((2x+1)·u·π / 2N), precomputed for the separable 2D DCT-II.
const COS = Array.from({ length: LOW }, (_, u) =>
  Float64Array.from({ length: SIZE }, (_, x) => Math.cos(((2 * x + 1) * u * Math.PI) / (2 * SIZE)))
);

// Decode any still or animated image (first frame), flatten transparency onto
// white and shrink to SIZE x SIZE greyscale.
async function greyscalePixels(buffer) {
  const { data } = await sharp(buffer, { animated: false })
    .flatten({ background: '#ffffff' })
    .greyscale()
    .resize(SIZE, SIZE, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return data;
}

function stddev(px) {
  let sum = 0;
  for (const v of px) sum += v;
  const mean = sum / px.length;
  let sq = 0;
  for (const v of px) sq += (v - mean) ** 2;
  return Math.sqrt(sq / px.length);
}

// Low-frequency block of the 2D DCT-II of a SIZE x SIZE pixel array.
function lowDct(px) {
  const rows = []; // rows[y][u]: DCT along x of each pixel row
  for (let y = 0; y < SIZE; y++) {
    const r = new Float64Array(LOW);
    for (let u = 0; u < LOW; u++) {
      let s = 0;
      for (let x = 0; x < SIZE; x++) s += px[y * SIZE + x] * COS[u][x];
      r[u] = s;
    }
    rows.push(r);
  }
  const out = new Float64Array(LOW * LOW); // out[v*LOW+u]
  for (let v = 0; v < LOW; v++) {
    for (let u = 0; u < LOW; u++) {
      let s = 0;
      for (let y = 0; y < SIZE; y++) s += rows[y][u] * COS[v][y];
      out[v * LOW + u] = s;
    }
  }
  return out;
}

// { hash: 16 hex chars, detail: greyscale stddev }. A bit is set when its
// coefficient is above the block's median.
async function phash(buffer) {
  const px = await greyscalePixels(buffer);
  const coeffs = lowDct(px);
  const sorted = [...coeffs].sort((a, b) => a - b);
  const median = (sorted[31] + sorted[32]) / 2;
  let bits = 0n;
  for (let i = 0; i < 64; i++) if (coeffs[i] > median) bits |= 1n << BigInt(63 - i);
  return { hash: bits.toString(16).padStart(16, '0'), detail: stddev(px) };
}

function hamming(a, b) {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let n = 0;
  while (x) {
    x &= x - 1n;
    n++;
  }
  return n;
}

// Nearest row (each with a `phash`) as { row, distance }, or null for no rows.
function nearest(hash, rows) {
  let best = null;
  for (const row of rows) {
    const distance = hamming(hash, row.phash);
    if (!best || distance < best.distance) best = { row, distance };
  }
  return best;
}

// Small png preview for log embeds.
function thumbnail(buffer) {
  return sharp(buffer, { animated: false }).resize(128, 128, { fit: 'cover' }).png().toBuffer();
}

module.exports = { MIN_DETAIL, phash, hamming, nearest, thumbnail };
