// Standalone, re-runnable member-stats collection. The actual scanning/parsing
// lives in src/memberStatsCollector.js (shared with the bot's scheduled run);
// this file is just the CLI wrapper: its own throwaway Discord client + Postgres
// pool, run one pass, exit.
//
//   npm run member-stats            → full scan of all history (rebuild / backfill)
//   npm run member-stats:catchup    → incremental (stops just past what's stored)
//
// It reads the SAME .env as the bot (DISCORD_TOKEN + DATABASE_URL). Re-running is
// always safe — every row is keyed on its source message id with ON CONFLICT.
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client, GatewayIntentBits } = require('discord.js');
const { Pool } = require('pg');
const collector = require('./memberStatsCollector');

const INCREMENTAL = process.argv.includes('--incremental');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 3,
});
pool.on('error', (err) => console.error('[db] idle client error:', err.message));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // needed to read other authors' embeds
  ],
});

client.once('clientReady', async () => {
  console.log(
    `Logged in as ${client.user.tag} — gathering member stats` +
      (INCREMENTAL ? ' (incremental).' : ' (full scan).')
  );
  try {
    await collector.collect({ client, pool, incremental: INCREMENTAL, quiet: false });
    console.log('Done.');
  } catch (err) {
    console.error('Failed:', err);
    process.exitCode = 1;
  } finally {
    await pool.end();
    client.destroy();
    process.exit(process.exitCode || 0);
  }
});

process.on('unhandledRejection', (err) => {
  console.error('[unhandled]', err);
  process.exit(1);
});

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('Login failed:', err.message);
  process.exit(1);
});
