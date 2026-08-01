const { pool } = require('../db');

async function query(text, params) {
  return pool.query(text, params);
}

async function init() {
  await query(`
    CREATE TABLE IF NOT EXISTS polls (
      poll_id       TEXT PRIMARY KEY,
      guild_id      TEXT NOT NULL,
      channel_id    TEXT NOT NULL,
      message_id    TEXT,
      creator_id    TEXT NOT NULL,
      question      TEXT NOT NULL,
      choices       TEXT[] NOT NULL,
      votes_allowed INT NOT NULL,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      ends_at       TIMESTAMPTZ NOT NULL,
      closed_at     TIMESTAMPTZ,
      active        BOOLEAN NOT NULL DEFAULT true
    );
  `);
  await query('CREATE INDEX IF NOT EXISTS polls_active_ends_idx ON polls (active, ends_at);');
  await query(`
    CREATE TABLE IF NOT EXISTS poll_votes (
      poll_id      TEXT NOT NULL REFERENCES polls(poll_id) ON DELETE CASCADE,
      user_id      TEXT NOT NULL,
      choice_index INT NOT NULL,
      voted_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (poll_id, user_id, choice_index)
    );
  `);
  await query('CREATE INDEX IF NOT EXISTS poll_votes_poll_idx ON poll_votes (poll_id);');
}

async function createPoll(poll) {
  await query(
    `INSERT INTO polls (
       poll_id, guild_id, channel_id, message_id, creator_id,
       question, choices, votes_allowed, ends_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      poll.pollId,
      poll.guildId,
      poll.channelId,
      poll.messageId,
      poll.creatorId,
      poll.question,
      poll.choices,
      poll.votesAllowed,
      poll.endsAt,
    ]
  );
}

async function setPollMessage(pollId, messageId) {
  await query('UPDATE polls SET message_id = $2 WHERE poll_id = $1', [pollId, messageId]);
}

async function getPoll(pollId) {
  const { rows } = await query('SELECT * FROM polls WHERE poll_id = $1', [pollId]);
  return rows[0] ?? null;
}

async function getPollByMessage(messageId) {
  const { rows } = await query('SELECT * FROM polls WHERE message_id = $1', [messageId]);
  return rows[0] ?? null;
}

async function getActivePolls() {
  const { rows } = await query('SELECT * FROM polls WHERE active = true ORDER BY ends_at ASC');
  return rows;
}

async function generatePollId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let attempt = 0; attempt < 10; attempt++) {
    let id = '';
    for (let i = 0; i < 10; i++) id += chars[Math.floor(Math.random() * chars.length)];
    const existing = await getPoll(id);
    if (!existing) return id;
  }
  throw new Error('Could not allocate a unique poll id');
}

async function getVoteCounts(pollId) {
  const { rows } = await query(
    `SELECT choice_index, COUNT(*)::int AS count
     FROM poll_votes
     WHERE poll_id = $1
     GROUP BY choice_index`,
    [pollId]
  );
  return rows;
}

async function getUserVotes(pollId, userId) {
  const { rows } = await query(
    `SELECT choice_index
     FROM poll_votes
     WHERE poll_id = $1 AND user_id = $2
     ORDER BY choice_index ASC`,
    [pollId, userId]
  );
  return rows.map((row) => row.choice_index);
}

async function toggleVote(pollId, userId, choiceIndex) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const pollRes = await client.query('SELECT * FROM polls WHERE poll_id = $1 FOR UPDATE', [pollId]);
    const poll = pollRes.rows[0] ?? null;
    if (!poll) {
      await client.query('ROLLBACK');
      return { status: 'missing' };
    }
    if (!poll.active || new Date(poll.ends_at).getTime() <= Date.now()) {
      await client.query('ROLLBACK');
      return { status: 'closed', poll };
    }
    if (choiceIndex < 0 || choiceIndex >= poll.choices.length) {
      await client.query('ROLLBACK');
      return { status: 'invalid', poll };
    }

    const existingRes = await client.query(
      `SELECT choice_index
       FROM poll_votes
       WHERE poll_id = $1 AND user_id = $2
       ORDER BY choice_index ASC`,
      [pollId, userId]
    );
    const current = existingRes.rows.map((row) => row.choice_index);
    if (current.includes(choiceIndex)) {
      await client.query(
        'DELETE FROM poll_votes WHERE poll_id = $1 AND user_id = $2 AND choice_index = $3',
        [pollId, userId, choiceIndex]
      );
      await client.query('COMMIT');
      return { status: 'removed', poll, votes: current.filter((i) => i !== choiceIndex) };
    }
    if (current.length >= poll.votes_allowed) {
      await client.query('ROLLBACK');
      return { status: 'limit', poll, votes: current };
    }
    await client.query(
      `INSERT INTO poll_votes (poll_id, user_id, choice_index)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [pollId, userId, choiceIndex]
    );
    await client.query('COMMIT');
    return { status: 'added', poll, votes: [...current, choiceIndex].sort((a, b) => a - b) };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function closePoll(pollId) {
  const { rows } = await query(
    `UPDATE polls
     SET active = false, closed_at = COALESCE(closed_at, now())
     WHERE poll_id = $1
     RETURNING *`,
    [pollId]
  );
  return rows[0] ?? null;
}

module.exports = {
  init,
  createPoll,
  setPollMessage,
  getPoll,
  getPollByMessage,
  getActivePolls,
  generatePollId,
  getVoteCounts,
  getUserVotes,
  toggleVote,
  closePoll,
};
