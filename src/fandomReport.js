// Same-fandom report. When a day's labeller run is over (advertLabeller.js) —
// every batch saved, reposts given their labels — this posts one message to
// FANDOM_REPORT_CHANNEL_ID (#bot_spam) listing each poster with two standing
// one-on-one adverts that share a fandom, one line per pair:
//   @poster <link to the newer advert> <link to the older advert>
// Only pairs with an advert labelled since the last report are listed, so a pair
// shows up once (again only if one of the two is edited and re-labelled). The
// first post opens by pinging ADREVIEWERS; the posters' mentions don't ping.
// Over Discord's 2000 characters it continues in more posts.
//
// CLI (no Discord login; uses .env): print what a report would list, post nothing.
//   node src/fandomReport.js --since 2026-10-01
require('dotenv').config();
const db = require('./db');
const config = require('./config');
const advertConfig = require('./advertConfig');
const { PROMPT_VERSION } = require('./advertLabeller');

const CHANNEL_ID = (process.env.FANDOM_REPORT_CHANNEL_ID ?? '406618336508510209').trim();
const ADVERT_CHANNELS = config.idList('FANDOM_REPORT_ADVERT_CHANNELS').length
  ? config.idList('FANDOM_REPORT_ADVERT_CHANNELS')
  : advertConfig.ONE_ON_ONE_CHANNELS;
// Pinged at the top of each report (the posters' mentions never ping).
const REVIEWERS = config.idList('ADREVIEWERS');
const MAX_CHARS = 2000;
const LIVE_GUILD_ID = '300829309214523392'; // the CLI's links (the bot reads it off the channel)

const messageLink = (guildId, channelId, id) => `https://discord.com/channels/${guildId}/${channelId}/${id}`;

// Pairs (from db.findSameFandomPairs) → one line each.
function reportLines(pairs, guildId) {
  return pairs.map(
    (p) =>
      `<@${p.author_id}> ${messageLink(guildId, p.new_channel_id, p.new_id)} ` +
      `${messageLink(guildId, p.old_channel_id, p.old_id)}`
  );
}

// The report's posts: a line pinging the reviewers (if any), then the pair lines.
// Returns [{ content, allowedMentions }]; only the first post pings anyone.
function reportPosts(pairs, guildId, reviewers = REVIEWERS) {
  const head = reviewers.length ? [reviewers.map((id) => `<@${id}>`).join(' ')] : [];
  return chunkLines([...head, ...reportLines(pairs, guildId)]).map((content, i) => ({
    content,
    allowedMentions: { parse: [], users: i === 0 ? reviewers : [] },
  }));
}

// Lines → posts of at most `max` characters, never splitting a line.
function chunkLines(lines, max = MAX_CHARS) {
  const posts = [];
  let cur = '';
  for (const line of lines) {
    if (cur && cur.length + 1 + line.length > max) {
      posts.push(cur);
      cur = '';
    }
    cur = cur ? `${cur}\n${line}` : line;
  }
  if (cur) posts.push(cur);
  return posts;
}

// The day's report. `date` is the run's Eastern date; `runStart` bounds the very
// first report (later ones pick up where the last ended). Claimed in the DB first,
// so a restart can't post a day twice; a failed post releases the claim.
async function run(client, { date, runStart }) {
  if (!CHANNEL_ID) return;
  const claim = await db.claimFandomReport(date, runStart);
  if (!claim) return; // already reported today
  try {
    const pairs = await db.findSameFandomPairs(
      PROMPT_VERSION,
      ADVERT_CHANNELS,
      claim.covered_from,
      claim.covered_until
    );
    if (pairs.length) {
      const channel = await client.channels.fetch(CHANNEL_ID);
      for (const post of reportPosts(pairs, channel.guildId)) await channel.send(post);
    }
    await db.completeFandomReport(date, pairs.length);
    console.log(`[fandom-report] ${date}: ${pairs.length} same-fandom pair(s)${pairs.length ? ' posted' : ''}.`);
  } catch (err) {
    await db.releaseFandomReport(date).catch(() => {});
    throw err;
  }
}

async function cli(argv) {
  const at = argv.indexOf('--since');
  const since = at >= 0 ? new Date(argv[at + 1]) : null;
  if (!since || Number.isNaN(since.getTime())) {
    console.log('usage: node src/fandomReport.js --since YYYY-MM-DD');
    return;
  }
  const pairs = await db.findSameFandomPairs(PROMPT_VERSION, ADVERT_CHANNELS, since, new Date());
  for (const line of reportLines(pairs, LIVE_GUILD_ID)) console.log(line);
  console.log(`[fandom-report] ${pairs.length} pair(s) with an advert labelled since ${since.toISOString()}.`);
}

if (require.main === module) {
  cli(process.argv.slice(2))
    .catch((err) => {
      console.error('[fandom-report]', err.message);
      process.exitCode = 1;
    })
    .finally(() => db.pool.end());
}

module.exports = { run, reportLines, reportPosts, chunkLines, CHANNEL_ID };
