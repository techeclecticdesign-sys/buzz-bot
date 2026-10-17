const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { create, parseAge, CHANNEL_ID } = require('./memberAges');
const db = require('./db');
after(() => db.pool.end());

function member(id) {
  return { id, guild: { id: 'guild' }, user: { tag: id, bot: false },
    roles: { cache: new Map() }, displayName: id };
}
function message(id, userId, content, time = '2025-05-05T12:00:00Z') {
  return { id, author: { id: userId, bot: false }, content, createdAt: new Date(time),
    channelId: CHANNEL_ID, guild: { id: 'guild', members: { fetch: async () => member(userId) } } };
}
function store() {
  const records = new Map();
  const data = {
    records,
    seedMemberState: async (id) => { if (!records.has(id)) records.set(id, {}); },
    setMemberAge: async (id, age, at, messageId) => {
      const old = records.get(id);
      if (!old || (old.at && old.at >= at)) return 0;
      records.set(id, { age, at, messageId });
      return 1;
    },
    deleteMemberState: async (id) => records.delete(id),
    pruneDepartedMemberState: async (ids) => {
      for (const id of records.keys()) if (!ids.includes(id)) records.delete(id);
    },
  };
  data.setMemberAges = async (rows) => {
    let saved = 0;
    for (const r of rows) {
      await data.seedMemberState(r.user_id);
      saved += await data.setMemberAge(r.user_id, r.age_stated, r.age_stated_at, r.age_message_id);
    }
    return saved;
  };
  return data;
}

test('age-channel parser accepts only whole two-digit statements from 15 through 99', () => {
  for (const text of ['15', '19', '20', '99', ' 27\n']) assert.equal(parseAge(text), Number(text));
  for (const text of ['14', '09', '100', '18+', 'I am 22', '27M', '19.5', '1e1', '', '20 years', null]) {
    assert.equal(parseAge(text), null, String(text));
  }
});

test('live ages persist their original message date and update only for the right channel and a present human', async () => {
  const data = store();
  const tracker = create({ store: data });
  await tracker.onMessage(message('101', 'a', '19'));
  assert.deepEqual(data.records.get('a'), { age: 19, at: new Date('2025-05-05T12:00:00Z'), messageId: '101' });
  await tracker.onMessage({ ...message('102', 'a', '20'), channelId: 'other' });
  await tracker.onMessage({ ...message('103', 'a', '20'), author: { id: 'a', bot: true } });
  await tracker.onMessage(message('104', 'a', '20 years'));
  const gone = message('105', 'b', '18');
  gone.guild.members.fetch = async () => { throw Object.assign(new Error('gone'), { status: 404 }); };
  await tracker.onMessage(gone);
  assert.equal(data.records.size, 1);
  assert.equal(data.records.get('a').age, 19);
  await tracker.onMessage(message('106', 'a', '20', '2026-02-01T12:00:00Z'));
  assert.equal(data.records.get('a').age, 20);
});

test('backfill scans history, chooses the newest valid age, skips departed members, and does not roll back a live update', async () => {
  const data = store();
  data.records.set('departed', { age: 15 });
  const tracker = create({ store: data });
  await tracker.onMessage(message('999', 'a', '20', '2026-05-05T12:00:00Z'));
  const members = new Map([['a', member('a')], ['b', member('b')]]);
  const pages = [
    [message('400', 'a', '19'), message('399', 'b', '19+'), message('398', 'departed', '15')],
    [message('300', 'b', '17'), message('299', 'b', '16'), message('298', 'a', '18')],
    [],
  ];
  const cursors = [];
  const client = { guilds: { cache: new Map([['guild', {}]]) }, channels: { fetch: async () => ({
    guild: { members: { fetch: async () => members } },
    messages: { fetch: async (opts) => {
      cursors.push(opts.before);
      return new Map(pages.shift().map((m) => [m.id, m]));
    } },
  }) } };
  const result = await tracker.backfill(client);
  assert.deepEqual(result, { scanned: 6, members: 2, saved: 1 });
  assert.deepEqual(cursors, [undefined, '398', '298']);
  assert.equal(data.records.get('a').age, 20);
  assert.equal(data.records.get('b').age, 17);
  assert.equal(data.records.has('departed'), false);
});

test('a departure during a pending age fetch cannot recreate the member; a rejoin can record a fresh declaration', async () => {
  const data = store();
  const tracker = create({ store: data });
  let resolve;
  const pending = message('200', 'a', '18');
  pending.guild.members.fetch = () => new Promise((r) => { resolve = r; });
  const task = tracker.onMessage(pending);
  await tracker.onLeave(member('a'));
  resolve(member('a'));
  await task;
  assert.equal(data.records.has('a'), false);
  tracker.onJoin(member('a'));
  await tracker.onMessage(message('201', 'a', '19'));
  assert.equal(data.records.get('a').age, 19);
});

test('an age fetch from a previous membership cannot write after a leave and rejoin', async () => {
  const data = store();
  const tracker = create({ store: data });
  let resolve;
  const pending = message('200', 'a', '18');
  pending.guild.members.fetch = () => new Promise((r) => { resolve = r; });
  const task = tracker.onMessage(pending);
  await tracker.onLeave(member('a'));
  tracker.onJoin(member('a'));
  resolve(member('a'));
  assert.equal(await task, false);
  assert.equal(data.records.has('a'), false);
  await tracker.onMessage(message('201', 'a', '19'));
  assert.equal(data.records.get('a').age, 19);
});

test('history pages cannot restore the old baseline after a leave and rejoin during backfill', async () => {
  const data = store();
  const tracker = create({ store: data });
  const members = new Map([['a', member('a')]]);
  let page = 0;
  const client = { guilds: { cache: new Map([['guild', {}]]) }, channels: { fetch: async () => ({
    guild: { members: { fetch: async () => members } },
    messages: { fetch: async () => {
      if (page++) return new Map();
      await tracker.onLeave(member('a'));
      tracker.onJoin(member('a'));
      return new Map([['200', message('200', 'a', '18')]]);
    } },
  }) } };
  await tracker.backfill(client);
  assert.equal(data.records.has('a'), false);
});

test('a queued member update is invalidated on departure, including a later rejoin', async () => {
  const tracker = create({ store: store() });
  const isCurrent = tracker.current(member('a'));
  assert.equal(isCurrent(), true);
  await tracker.onLeave(member('a'));
  assert.equal(isCurrent(), false);
  tracker.onJoin(member('a'));
  assert.equal(isCurrent(), false);
  assert.equal(tracker.current(member('a'))(), true);
});
