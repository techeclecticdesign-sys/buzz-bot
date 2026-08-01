// Optional local JSON archive. When JSON_ARCHIVE_DIR is set, every archived
// message and every edit/delete event is appended as one JSON object per line
// (JSONL) to <dir>/<guildId>/<channel-name>-<channelId>.jsonl.
// Leave the env var unset (e.g. on the bot host) to disable entirely.
const fs = require('fs');
const path = require('path');

const DIR = process.env.JSON_ARCHIVE_DIR;

function sanitize(name) {
  return String(name).replace(/[^\w-]+/g, '_');
}

function append(guildId, channelId, channelName, record) {
  if (!DIR || !guildId) return;
  try {
    const dir = path.join(DIR, sanitize(guildId));
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${sanitize(channelName ?? 'channel')}-${channelId}.jsonl`);
    fs.appendFileSync(file, JSON.stringify(record) + '\n');
  } catch (err) {
    console.error('[json-archive] write failed:', err.message);
  }
}

module.exports = { append };
