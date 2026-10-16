// Banned marketer profile pictures, matched by perceptual hash (see pfpHash.js).
const { query } = require('./pool');

async function listMarketerPfps() {
  const { rows } = await query(
    `SELECT id, phash, source_user_id, note, added_by, created_at, hits, last_hit_at
       FROM marketer_pfps ORDER BY id`
  );
  return rows;
}

async function getMarketerPfpThumb(id) {
  const { rows } = await query('SELECT thumb FROM marketer_pfps WHERE id = $1', [id]);
  return rows[0]?.thumb ?? null;
}

async function addMarketerPfp({ phash, thumb, sourceUserId, note, addedBy }) {
  const { rows } = await query(
    `INSERT INTO marketer_pfps (phash, thumb, source_user_id, note, added_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [phash, thumb, sourceUserId ?? null, note ?? null, addedBy]
  );
  return rows[0].id;
}

async function deleteMarketerPfp(id) {
  const { rowCount } = await query('DELETE FROM marketer_pfps WHERE id = $1', [id]);
  return rowCount > 0;
}

async function recordMarketerPfpHit(id) {
  await query(
    'UPDATE marketer_pfps SET hits = hits + 1, last_hit_at = now() WHERE id = $1',
    [id]
  );
}

module.exports = {
  listMarketerPfps,
  getMarketerPfpThumb,
  addMarketerPfp,
  deleteMarketerPfp,
  recordMarketerPfpHit,
};
