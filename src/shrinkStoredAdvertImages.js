// One-off: re-encodes the group-advert images already stored with shrinkImage
// (new captures are shrunk as they're stored). Each image is updated in its own
// transaction, and only if its bytes are unchanged since they were read, so a live
// edit is never overwritten. Its messages.attachments entry gets the new type,
// size and dimensions; the filename stays. Back up group_advert_images first.
//   node src/shrinkStoredAdvertImages.js            report only
//   node src/shrinkStoredAdvertImages.js --apply    write
require('dotenv').config();
const crypto = require('crypto');
const { pool } = require('./db/pool');
const { shrinkImage } = require('./advertImages');

const APPLY = process.argv.includes('--apply');

async function shrinkOne(client, messageId, pos) {
  const { rows } = await client.query(
    'SELECT image, content_type FROM group_advert_images WHERE message_id = $1 AND pos = $2',
    [messageId, pos]
  );
  if (!rows[0]) return 'gone';
  const before = rows[0].image;
  const out = await shrinkImage({ buffer: before, contentType: rows[0].content_type });
  if (out.buffer === before) return 'kept';
  if (!APPLY) return { from: before.length, to: out.buffer.length };

  await client.query('BEGIN');
  try {
    const res = await client.query(
      `UPDATE group_advert_images SET image = $3, content_type = $4
        WHERE message_id = $1 AND pos = $2 AND md5(image) = $5`,
      [messageId, pos, out.buffer, out.contentType, crypto.createHash('md5').update(before).digest('hex')]
    );
    if (res.rowCount !== 1) {
      await client.query('ROLLBACK');
      return 'changed';
    }
    await client.query(
      `UPDATE messages SET attachments = (
         SELECT jsonb_agg(CASE WHEN (a->>'pos')::int = $2
                  THEN a || jsonb_build_object('contentType', $3::text, 'size', $4::int,
                                               'width', $5::int, 'height', $6::int)
                  ELSE a END ORDER BY ord)
           FROM jsonb_array_elements(attachments) WITH ORDINALITY AS t(a, ord))
        WHERE id = $1 AND attachments IS NOT NULL`,
      [messageId, pos, out.contentType, out.size, out.width, out.height]
    );
    await client.query('COMMIT');
    return { from: before.length, to: out.buffer.length };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  }
}

async function main() {
  const client = await pool.connect();
  try {
    const { rows: keys } = await client.query(
      'SELECT message_id, pos FROM group_advert_images ORDER BY message_id, pos'
    );
    const counts = { shrunk: 0, kept: 0, gone: 0, changed: 0 };
    let from = 0;
    let to = 0;
    for (const { message_id: id, pos } of keys) {
      const result = await shrinkOne(client, id, pos);
      if (typeof result === 'string') {
        counts[result]++;
        continue;
      }
      counts.shrunk++;
      from += result.from;
      to += result.to;
    }
    const mb = (n) => (n / 1e6).toFixed(1);
    console.log(`${APPLY ? 'Shrunk' : 'Would shrink'} ${counts.shrunk} of ${keys.length} images: ${mb(from)} MB → ${mb(to)} MB`);
    console.log(`kept ${counts.kept} (WebP not smaller), skipped ${counts.gone + counts.changed} (deleted or edited meanwhile)`);
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
