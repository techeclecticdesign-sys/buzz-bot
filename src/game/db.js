// Game persistence. Reuses the logger-bot's shared pg pool (one bot, one DB
// connection budget). All mutations go through a row-locked transaction so the
// economy can't be raced/duped — the reason this is a real bot, not YAGPDB.
const { pool } = require('../db');

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_players (
      user_id               TEXT PRIMARY KEY,
      level                 INT  NOT NULL DEFAULT 1,
      exp                   INT  NOT NULL DEFAULT 0,
      cash                  BIGINT NOT NULL DEFAULT 0,
      energy                DOUBLE PRECISION NOT NULL DEFAULT 10,
      energy_updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      strength              INT  NOT NULL DEFAULT 10,
      defense               INT  NOT NULL DEFAULT 10,
      trains_today          INT  NOT NULL DEFAULT 0,
      train_day             DATE,
      hp                    DOUBLE PRECISION NOT NULL DEFAULT 100,
      hp_updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
      hospital_until        TIMESTAMPTZ,
      weapon_id             TEXT NOT NULL DEFAULT 'fists',
      armor_id              TEXT NOT NULL DEFAULT 'none',
      property_id           TEXT,
      property_collected_at TIMESTAMPTZ,
      respect               INT  NOT NULL DEFAULT 0,
      last_attack_at        TIMESTAMPTZ,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  // This bot serves one server, so guild_id was redundant; drop it from existing
  // databases (it's a plain column, never part of the PK, so this is clean).
  await pool.query('ALTER TABLE game_players DROP COLUMN IF EXISTS guild_id;');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS game_attack_log (
      id          BIGSERIAL PRIMARY KEY,
      attacker_id TEXT NOT NULL,
      defender_id TEXT NOT NULL,
      won         BOOLEAN NOT NULL,
      cash_taken  BIGINT NOT NULL DEFAULT 0,
      at          TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

const COLS = [
  'level', 'exp', 'cash', 'energy', 'energy_updated_at', 'strength', 'defense',
  'trains_today', 'train_day', 'hp', 'hp_updated_at', 'hospital_until', 'weapon_id',
  'armor_id', 'property_id', 'property_collected_at', 'respect', 'last_attack_at',
];

// Write back every mutable column of a player row (within a transaction).
async function savePlayer(client, p) {
  const set = COLS.map((c, i) => `${c} = $${i + 2}`).join(', ');
  await client.query(`UPDATE game_players SET ${set} WHERE user_id = $1`, [p.user_id, ...COLS.map((c) => p[c])]);
}

// Run `fn(client, player)` with the player's row created-if-missing and locked
// FOR UPDATE, all inside one transaction. `fn` mutates `player` then usually
// calls savePlayer(client, player). Returns whatever `fn` returns.
async function withPlayer(userId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO game_players (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );
    const { rows } = await client.query('SELECT * FROM game_players WHERE user_id = $1 FOR UPDATE', [userId]);
    const result = await fn(client, rows[0]);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Lock two players in a fixed id order (deadlock-safe) for PvP. `fn` receives
// (client, attacker, defender) already resolved to the a/d roles.
async function withTwoPlayers(attackerId, defenderId, fn) {
  const [lo, hi] = [attackerId, defenderId].sort();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const id of [lo, hi]) {
      await client.query(
        `INSERT INTO game_players (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
        [id]
      );
    }
    const { rows } = await client.query(
      'SELECT * FROM game_players WHERE user_id = ANY($1) ORDER BY user_id FOR UPDATE',
      [[lo, hi]]
    );
    const byId = Object.fromEntries(rows.map((r) => [r.user_id, r]));
    const result = await fn(client, byId[attackerId], byId[defenderId]);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function logAttack(client, attackerId, defenderId, won, cashTaken) {
  await client.query(
    `INSERT INTO game_attack_log (attacker_id, defender_id, won, cash_taken) VALUES ($1, $2, $3, $4)`,
    [attackerId, defenderId, won, cashTaken]
  );
}

// Has this user ever played? (Used so you can't /hit someone who isn't in.)
async function playerExists(userId) {
  const { rows } = await pool.query('SELECT 1 FROM game_players WHERE user_id = $1', [userId]);
  return rows.length > 0;
}

// Read-only leaderboard by net-ish worth (cash). No lock.
async function top(limit = 10) {
  const { rows } = await pool.query(
    `SELECT user_id, level, cash, respect FROM game_players
     ORDER BY cash DESC, level DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

module.exports = { init, savePlayer, withPlayer, withTwoPlayers, logAttack, top, playerExists };
