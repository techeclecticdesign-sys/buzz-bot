// Helpers for capturing image attachments on GROUP advert posts, used by the
// live message handlers. Images are downloaded and handed to
// db.setAdvertAttachments, which stores the bytes so the browse site can show
// them even after Discord's signed CDN urls expire.

const sharp = require('sharp');
const advertConfig = require('./advertConfig');

// Skip anything larger than this so a stray huge upload can't bloat the table.
// Group-ad images are ordinarily well under this.
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp)$/i;

function isGroupChannel(channelId) {
  return advertConfig.typeForChannel(channelId)?.name === 'group';
}

// Is this attachment an image we want to keep? Prefer the declared content-type,
// fall back to the filename extension (some older uploads omit content_type).
// SVG is deliberately excluded: it's an active document (can carry <script>), so
// serving it inline on the site would be an XSS vector — raster formats only.
function isImage(contentType, filename) {
  if (contentType === 'image/svg+xml') return false;
  if (contentType && contentType.startsWith('image/')) return true;
  return !!filename && IMAGE_EXT_RE.test(filename);
}

// Order-independent signature of an image set (live descriptors or stored
// `attachments` metadata — both carry `filename`), so an edit can tell whether the
// images actually changed and avoid a needless re-download.
function imageSignature(list) {
  const names = (Array.isArray(list) ? list : []).map((a) => a.filename ?? '').sort();
  return JSON.stringify(names);
}

// Normalize a discord.js message's attachments (a Collection of Attachment) into
// our plain image descriptors, preserving order.
function fromDiscordMessage(message) {
  const out = [];
  let pos = 0;
  for (const a of message.attachments.values()) {
    if (!isImage(a.contentType, a.name)) continue;
    out.push({
      pos: pos++,
      url: a.url,
      filename: a.name ?? null,
      contentType: a.contentType || 'application/octet-stream',
      width: a.width ?? null,
      height: a.height ?? null,
      size: a.size ?? null,
    });
  }
  return out;
}

// How long to wait on a single image download before giving up, so a slow/hung
// CDN response can't stall the message handler indefinitely.
const DOWNLOAD_TIMEOUT_MS = 15000;

// Download the bytes for each descriptor, returning the subset that downloaded
// cleanly and fit under the size cap, each with a `buffer`. Best-effort: a
// single failed/oversized/slow image is skipped, not fatal.
async function downloadImages(descriptors) {
  const results = [];
  for (const d of descriptors) {
    if (d.size && d.size > MAX_IMAGE_BYTES) continue;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const res = await fetch(d.url, { signal: ctrl.signal });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) continue;
      results.push({ ...d, buffer: buf, size: buf.length });
    } catch {
      // skip this image (network error, abort/timeout, etc.)
    } finally {
      clearTimeout(timer);
    }
  }
  // Re-index pos to stay contiguous after any skips.
  return results.map((r, i) => ({ ...r, pos: i }));
}

// Stored images are re-encoded as WebP no larger than this on either side: the site
// serves them from the database on every view, so their size is its cost.
const MAX_DIMENSION = 2048;
const WEBP_QUALITY = 85;

// One downloaded image as WebP, scaled to fit MAX_DIMENSION (animation kept, EXIF
// orientation applied, metadata dropped). Keeps the original when the WebP isn't
// smaller or the image can't be read. The filename stays the original's, since
// imageSignature compares filenames.
async function shrinkImage(img) {
  try {
    const meta = await sharp(img.buffer).metadata();
    const animated = (meta.pages ?? 1) > 1;
    let pipeline = sharp(img.buffer, { animated });
    if (!animated) pipeline = pipeline.rotate();
    const { data, info } = await pipeline
      .resize(MAX_DIMENSION, MAX_DIMENSION, { fit: 'inside', withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer({ resolveWithObject: true });
    if (data.length >= img.buffer.length) return img;
    return {
      ...img,
      buffer: data,
      size: data.length,
      contentType: 'image/webp',
      width: info.width,
      // An animation's frames are stacked: info.height is all of them.
      height: animated ? info.pageHeight ?? Math.round(info.height / meta.pages) : info.height,
    };
  } catch {
    return img;
  }
}

async function shrinkImages(images) {
  const out = [];
  for (const img of images) out.push(await shrinkImage(img));
  return out;
}

module.exports = {
  MAX_IMAGE_BYTES,
  MAX_DIMENSION,
  isGroupChannel,
  isImage,
  imageSignature,
  fromDiscordMessage,
  downloadImages,
  shrinkImage,
  shrinkImages,
};
