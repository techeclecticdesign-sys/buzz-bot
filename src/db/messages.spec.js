// The message writes against an in-memory Postgres (PGlite): each one that can
// change what rpc-web shows reports the rows it touched, after they're committed,
// so sitePurge refreshes the cached pages. A write that reports nothing leaves a
// removed or edited ad on rpc-web's cached pages for up to a week.
const { test, before, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { PGlite } = require('@electric-sql/pglite');

let db;
const run = async (text, params) => {
  const res = await db.query(text, params);
  return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
};
// messages.js on PGlite in place of the pg pool. One connection, so a
// transaction's statements share it, as a pool client's do.
const poolPath = path.join(__dirname, 'pool.js');
require.cache[poolPath] = {
  id: poolPath,
  filename: poolPath,
  loaded: true,
  exports: { query: run, pool: { connect: async () => ({ query: run, release() {} }) } },
};
const messages = require('./messages');

const ADVERT = '504322272618610688';
const CHAT = '300829309214523392';
let reports;

before(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE messages (id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, author_id TEXT,
      author_tag TEXT, content TEXT, created_at TIMESTAMPTZ, edited_at TIMESTAMPTZ,
      deleted_at TIMESTAMPTZ, attachments JSONB, reactions JSONB);
    CREATE TABLE group_advert_images (
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE, pos INT NOT NULL,
      channel_id TEXT NOT NULL, image BYTEA NOT NULL, content_type TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY (message_id, pos));
  `);
  messages.onMessagesChanged((rows) => reports.push(rows));
});

beforeEach(async () => {
  await db.exec('TRUNCATE messages, group_advert_images');
  reports = [];
});

const msg = (id, channelId = ADVERT, extra = {}) => ({
  id,
  channelId,
  author: { id: 'u1', tag: 'user#1' },
  content: `ad ${id}`,
  createdAt: new Date('2026-10-01T00:00:00Z'),
  editedAt: null,
  attachments: new Map(),
  ...extra,
});
const seed = async (...rows) => {
  for (const r of rows) await messages.upsertMessage(r, { archive: false });
  reports = [];
};
const image = (pos) => ({ pos, contentType: 'image/webp', buffer: Buffer.from([pos]) });

test('upsertMessage reports a new row and a refreshed one, but not an unchanged insert', async () => {
  await messages.upsertMessage(msg('1'), { archive: false });
  await messages.upsertMessage(msg('1'), { archive: false }); // already stored: no change
  await messages.upsertMessage(msg('1', ADVERT, { content: 'edited' }), { archive: false, refresh: true });
  await messages.upsertMessage(msg('2', CHAT), { archive: false });
  assert.deepEqual(reports, [
    [{ id: '1', channelId: ADVERT }],
    [{ id: '1', channelId: ADVERT }],
    [{ id: '2', channelId: CHAT }], // filtered to adverts by sitePurge
  ]);
});

test('edits, reactions and deletes report the rows they changed', async () => {
  await seed(msg('1'), msg('2'), msg('3'));
  const editedAt = new Date('2026-10-02T00:00:00Z');
  await messages.updateContent('1', 'edited', editedAt);
  await messages.updateContent('1', 'edited', editedAt); // re-saved unchanged (the link check)
  await messages.setReactions('2', [{ id: 'e', name: 'staffapproved', count: 1 }]);
  await messages.setReactions('2', [{ name: 'staffapproved', count: 1, id: 'e' }]); // same summary
  await messages.markDeleted(['2', '3', 'missing']);
  await messages.markDeleted('1');
  await messages.updateContent('missing', 'x', new Date()); // no row: nothing to report
  assert.deepEqual(reports, [
    [{ id: '1', channelId: ADVERT }],
    [{ id: '2', channelId: ADVERT }],
    [{ id: '2', channelId: ADVERT }, { id: '3', channelId: ADVERT }],
    [{ id: '1', channelId: ADVERT }],
  ]);
});

test('group advert images report after their transaction commits, and not on a rollback', async () => {
  await seed(msg('1'));
  await messages.setAdvertAttachments('1', ADVERT, [image(0), image(1)]);
  assert.deepEqual(reports, [[{ id: '1', channelId: ADVERT }]]);
  const { rows } = await db.query("SELECT count(*)::int AS n FROM group_advert_images WHERE message_id = '1'");
  assert.equal(rows[0].n, 2, 'committed when reported');

  // A duplicate position fails the insert: the metadata update is rolled back.
  await assert.rejects(messages.setAdvertAttachments('1', ADVERT, [image(0), image(0)]));
  assert.equal(reports.length, 1, 'nothing reported for a rolled-back write');

  await messages.clearAdvertAttachments('1');
  assert.deepEqual(reports[1], [{ id: '1', channelId: ADVERT }]);
});

test('the advert retention prune reports the standing rows it deleted', async () => {
  await seed(msg('1'), msg('2', ADVERT, { createdAt: new Date('2026-10-20T00:00:00Z') }), msg('3', CHAT), msg('4'));
  await messages.markDeleted('4'); // reported when it was deleted
  reports = [];
  const n = await messages.pruneMessagesInChannels([ADVERT], new Date('2026-10-10T00:00:00Z'));
  assert.equal(n, 2);
  assert.deepEqual(reports, [[{ id: '1', channelId: ADVERT }]]);
});

test('a throwing listener never fails the write', async () => {
  messages.onMessagesChanged(() => {
    throw new Error('boom');
  });
  const errors = [];
  const realError = console.error;
  console.error = (...args) => errors.push(args.join(' '));
  try {
    await messages.updateContent('none', 'x', new Date());
    await seed(msg('1'));
    assert.match(errors.at(-1), /change listener failed: boom/);
  } finally {
    console.error = realError;
    messages.onMessagesChanged((rows) => reports.push(rows));
  }
});

test('unchanged re-saves write nothing, and clearing reactions still counts', async () => {
  await seed(msg('1'));
  await messages.updateContent('1', 'ad 1', null); // as stored
  await messages.setReactions('1', null); // none stored already
  assert.deepEqual(reports, []);
  await messages.setReactions('1', [{ id: 'e', name: 'x', count: 2 }]);
  await messages.setReactions('1', null);
  assert.equal(reports.length, 2);
  const { rows } = await db.query("SELECT reactions FROM messages WHERE id = '1'");
  assert.equal(rows[0].reactions, null);
});
