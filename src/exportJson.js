// Regenerates the local JSONL archive from the database. Overwrites the
// per-channel files, so it's the way to (re)build a complete offline copy —
// the live bot only appends records for events it personally witnessed.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, Events, GatewayIntentBits } = require('discord.js');
const { pool } = require('./db');

const DIR = process.env.JSON_ARCHIVE_DIR || 'archive';

function sanitize(name) {
  return String(name).replace(/[^\w-]+/g, '_');
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once(Events.ClientReady, async () => {
  // guild_id is no longer stored per message (single-server bot); take it from
  // the one guild we're in for the archive directory name.
  const guildId = client.guilds.cache.first()?.id ?? 'guild';

  // The database stores channel ids only; resolve current names for filenames.
  const names = new Map();
  for (const guild of client.guilds.cache.values()) {
    const channels = await guild.channels.fetch();
    for (const channel of channels.values()) {
      if (!channel) continue;
      names.set(channel.id, channel.name);
      if (channel.threads) {
        try {
          const active = await channel.threads.fetchActive();
          for (const t of active.threads.values()) names.set(t.id, t.name);
          const archived = await channel.threads.fetchArchived({ limit: 100 });
          for (const t of archived.threads.values()) names.set(t.id, t.name);
        } catch {
          // no thread access — fall back to id-only filenames
        }
      }
    }
  }

  const { rows } = await pool.query(
    'SELECT * FROM messages ORDER BY channel_id, created_at'
  );

  const streams = new Map();
  for (const r of rows) {
    const dir = path.join(DIR, sanitize(guildId));
    const file = path.join(
      dir,
      `${sanitize(names.get(r.channel_id) ?? 'channel')}-${r.channel_id}.jsonl`
    );
    let stream = streams.get(file);
    if (!stream) {
      fs.mkdirSync(dir, { recursive: true });
      stream = fs.createWriteStream(file); // overwrites: full regeneration
      streams.set(file, stream);
    }
    stream.write(
      JSON.stringify({
        type: 'message',
        id: r.id,
        authorId: r.author_id,
        authorTag: r.author_tag,
        content: r.content,
        createdAt: r.created_at?.toISOString() ?? null,
        editedAt: r.edited_at?.toISOString() ?? null,
        deletedAt: r.deleted_at?.toISOString() ?? null,
      }) + '\n'
    );
  }
  await Promise.all(
    [...streams.values()].map((s) => new Promise((resolve) => s.end(resolve)))
  );

  console.log(`Exported ${rows.length} messages into ${streams.size} files under ${DIR}/`);
  await pool.end();
  client.destroy();
  process.exit(0);
});

process.on('unhandledRejection', (err) => {
  console.error('[unhandled]', err);
  process.exit(1);
});

client.login(process.env.DISCORD_TOKEN);
