// Canonical text hash used to recognize an identical advert repost by the same
// author. This function MUST stay byte-identical to its copies in rpc-web
// (lib/advertHash.ts) and the seed script — any drift silently breaks matching.
// The pinned vector in advertHash.spec.js (mirrored in rpc-web) guards against it.
const { createHash } = require('node:crypto');

// Collapse every whitespace run to a single space and trim the ends. A blank or
// whitespace-only input yields ''.
function normalizeAdvertText(content) {
  if (typeof content !== 'string') return '';
  return content.replace(/\s+/g, ' ').trim();
}

// sha256 (hex) of the normalized text, or null when there's nothing to match on.
// Blank / image-only posts return null so they never collect a hash and thus can
// never blanket-match every other empty post by the same author.
function advertContentHash(content) {
  const normalized = normalizeAdvertText(content);
  if (!normalized) return null;
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

module.exports = { normalizeAdvertText, advertContentHash };
