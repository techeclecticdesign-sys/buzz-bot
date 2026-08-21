// Shared pg connection pool + a retrying query() wrapper. Everything under db/
// imports from here, so the whole bot runs on one connection budget.
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 5,
});

// Neon closes idle connections when its compute autosuspends; without this
// handler a dropped idle client crashes the process.
pool.on('error', (err) => {
  console.error('[db] idle client error:', err.message);
});

// Transient network/Neon-wakeup errors shouldn't lose a message: retry with
// backoff before giving up.
async function query(text, params, attempts = 3) {
  let delay = 2000;
  for (let i = 1; ; i++) {
    try {
      return await pool.query(text, params);
    } catch (err) {
      if (i >= attempts) throw err;
      console.warn(`[db] ${err.message} — retrying in ${delay / 1000}s (${i}/${attempts - 1})`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay *= 2;
    }
  }
}

module.exports = { pool, query };
