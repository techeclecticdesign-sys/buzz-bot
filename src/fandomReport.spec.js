// The same-fandom report: line format and splitting, plus its SQL against an
// in-memory Postgres (PGlite) carrying the same schema init() creates.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { PGlite } = require('@electric-sql/pglite');
const { initAdvertLabels } = require('./db/advertLabelsSchema');
const { SAME_FANDOM_SQL, CLAIM_FANDOM_REPORT_SQL } = require('./db/advertLabels');
const { reportLines, reportPosts, chunkLines } = require('./fandomReport');

const VERSION = 'rpc14-v1';
const GUILD = '300829309214523392';
const ONE = '504322252611780609'; // fandom_adverts
const QUICK = '595368989706813444'; // quick_fandoms
const GROUP = '595369286160089109'; // fandom_groups (not compared)

let db;

before(async () => {
  db = new PGlite();
  await initAdvertLabels((sql) => db.exec(sql));
  await initAdvertLabels((sql) => db.exec(sql)); // idempotent on a second boot
  await db.exec(`CREATE TABLE messages (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, author_id TEXT,
                   created_at TIMESTAMPTZ, deleted_at TIMESTAMPTZ)`);
});

async function ad(id, { author, channel = ONE, posted, fandoms, labelled = 'now()', deleted = false }) {
  await db.query(
    `INSERT INTO messages (id, channel_id, author_id, created_at, deleted_at)
     VALUES ($1, $2, $3, $4, ${deleted ? 'now()' : 'NULL'})`,
    [id, channel, author, posted]
  );
  await db.query(
    `INSERT INTO advert_labels (message_id, prompt_version, content_rev, labels, categories, firm_categories, fandoms, labelled_at)
     VALUES ($1, $2, 'r', '[]', '{}', '{}', $3, ${labelled})`,
    [id, VERSION, fandoms]
  );
}

test('reportLines: mention, newer ad link, older ad link — one line per pair', () => {
  const lines = reportLines(
    [{ author_id: '376617185033977857', new_id: '1556983134506065971', new_channel_id: ONE,
       old_id: '1538969502736326747', old_channel_id: QUICK }],
    GUILD
  );
  assert.deepEqual(lines, [
    `<@376617185033977857> https://discord.com/channels/${GUILD}/${ONE}/1556983134506065971 ` +
      `https://discord.com/channels/${GUILD}/${QUICK}/1538969502736326747`,
  ]);
});

test('reportPosts pings the reviewers once, at the top of the first post; posters never', () => {
  const pairs = Array.from({ length: 25 }, (_, i) => ({
    author_id: `9000000000000000${i}`, new_id: '1556983134506065971', new_channel_id: ONE,
    old_id: '1538969502736326747', old_channel_id: QUICK,
  }));
  const reviewers = ['962175556055617546', '671760757679194231'];
  const posts = reportPosts(pairs, GUILD, reviewers);
  assert.ok(posts.length > 1);
  assert.equal(posts[0].content.split('\n')[0], '<@962175556055617546> <@671760757679194231>');
  assert.equal(posts[0].content.split('\n')[1],
    'A new or updated advert shares fandoms with another active advert by the same poster.');
  assert.deepEqual(posts[0].allowedMentions, { parse: [], users: reviewers });
  for (const p of posts.slice(1)) assert.deepEqual(p.allowedMentions, { parse: [], users: [] });
  // No reviewers set: the explanation and pair lines, nobody pinged.
  const quiet = reportPosts(pairs.slice(0, 1), GUILD, []);
  assert.equal(quiet[0].content.split('\n')[0],
    'A new or updated advert shares fandoms with another active advert by the same poster.');
  assert.ok(quiet[0].content.split('\n')[1].startsWith(`<@${pairs[0].author_id}> https://`));
  assert.deepEqual(quiet[0].allowedMentions.users, []);
});

test('chunkLines keeps whole lines and every post under the limit', () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i} ${'x'.repeat(190)}`);
  const posts = chunkLines(lines, 2000);
  assert.ok(posts.length > 1);
  for (const p of posts) assert.ok(p.length <= 2000);
  assert.deepEqual(posts.join('\n').split('\n'), lines);
  assert.deepEqual(chunkLines([]), []);
});

test('pairs: same poster, standing, shared fandom (case/punctuation-blind), one side freshly labelled', async () => {
  const old = "now() - interval '3 days'";
  // Poster A: a fresh ad sharing "Star Wars" with an older standing one → reported.
  await ad('a-old', { author: 'A', channel: QUICK, posted: '2026-08-17', fandoms: ['Star Wars', 'Marvel'], labelled: old });
  await ad('a-new', { author: 'A', posted: '2026-10-06', fandoms: ['star-wars', 'Dune'] });
  // Poster A also has a group ad with Star Wars: groups aren't compared.
  await ad('a-group', { author: 'A', channel: GROUP, posted: '2026-10-01', fandoms: ['Star Wars'], labelled: old });
  // Poster B: same fandom, but the older ad is deleted → nothing.
  await ad('b-old', { author: 'B', posted: '2026-09-01', fandoms: ['Bleach'], labelled: old, deleted: true });
  await ad('b-new', { author: 'B', posted: '2026-10-10', fandoms: ['Bleach'] });
  // Poster C: two standing ads, no fandom in common → nothing.
  await ad('c-old', { author: 'C', posted: '2026-09-01', fandoms: ['Naruto'], labelled: old });
  await ad('c-new', { author: 'C', posted: '2026-10-10', fandoms: ['One Piece'] });
  // Poster D: shared fandom but both labelled before the window → already reported.
  await ad('d-old', { author: 'D', posted: '2026-09-01', fandoms: ['Arcane'], labelled: old });
  await ad('d-new', { author: 'D', posted: '2026-09-05', fandoms: ['Arcane'], labelled: old });
  // Poster E: the OLDER ad was edited and re-labelled → still reported, newer ad first.
  await ad('e-old', { author: 'E', posted: '2026-09-01', fandoms: ['Hades'] });
  await ad('e-new', { author: 'E', posted: '2026-09-20', fandoms: ['HADES '], labelled: old });
  // Different posters with the same fandom → nothing.
  await ad('f-new', { author: 'F', posted: '2026-10-11', fandoms: ['Star Wars'] });

  const since = new Date(Date.now() - 24 * 3600 * 1000);
  const { rows } = await db.query(SAME_FANDOM_SQL, [VERSION, [ONE, QUICK], since, new Date(Date.now() + 60_000)]);
  assert.deepEqual(
    rows.map((r) => [r.author_id, r.new_id, r.new_channel_id, r.old_id, r.old_channel_id]),
    [
      ['A', 'a-new', ONE, 'a-old', QUICK],
      ['E', 'e-new', ONE, 'e-old', ONE],
    ]
  );
});

test('a day is claimed once; each report starts where the last ended', async () => {
  const first = new Date('2026-10-14T12:00:00Z');
  const a = (await db.query(CLAIM_FANDOM_REPORT_SQL, ['2026-10-14', first])).rows[0];
  assert.equal(a.covered_from.toISOString(), first.toISOString());
  assert.equal((await db.query(CLAIM_FANDOM_REPORT_SQL, ['2026-10-14', first])).rows.length, 0); // restart: no repost
  const b = (await db.query(CLAIM_FANDOM_REPORT_SQL, ['2026-10-15', new Date()])).rows[0];
  assert.equal(b.covered_from.toISOString(), a.covered_until.toISOString());
});

test('the report table is closed to the API roles like the other labeller tables', async () => {
  const { rows } = await db.query(
    `SELECT relrowsecurity FROM pg_class WHERE relname = 'advert_fandom_reports'`
  );
  assert.equal(rows[0].relrowsecurity, true);
});
