const { test, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const { create } = require('./tcgApproval');

const EMOJI = '1358879847664975902';
const CARD = '900';

beforeEach(() => {
  mock.method(console, 'error', () => {});
  mock.method(console, 'warn', () => {});
  mock.method(console, 'log', () => {});
});

// Fake db: `cards` are the card message ids; writes are recorded in order.
function fakeStore(cards = [CARD], rows = []) {
  const writes = [];
  const store = {
    writes,
    isTcgCardMessage: async (id) => cards.includes(id),
    listCalls: [],
    listTcgCards: async (opts) => {
      store.listCalls.push(opts);
      return rows;
    },
    setTcgCardApproval: async (id, approved) => {
      writes.push([id, approved]);
    },
    deleted: [],
    unapproveDeletedTcgCards: async (gone) => {
      store.deleted.push(gone);
    },
  };
  return store;
}

function messageWith(emojiIds) {
  return { reactions: { cache: new Map(emojiIds.map((id, i) => [String(i), { emoji: { id } }])) } };
}

function notFound() {
  return Object.assign(new Error('Unknown Message'), { status: 404 });
}

// A reaction event on message `id`; fetch() resolves to `fetched` or rejects with it.
function reaction(id, emojiId, fetched) {
  const fetch = mock.fn(async () => {
    if (fetched instanceof Error) throw fetched;
    return fetched;
  });
  return { emoji: { id: emojiId }, message: { id, fetch } };
}

test('the default card store supports reconciliation, reactions, and deletion', async (t) => {
  const { pool } = require('./db/pool');
  const queries = t.mock.method(pool, 'query', async (sql) => {
    if (sql.startsWith('SELECT message_id')) {
      return { rows: [{ message_id: CARD, channel_id: 'thread-1' }] };
    }
    return { rows: [{ '?column?': 1 }] };
  });
  const client = {
    channels: { fetch: async () => ({ messages: { fetch: async () => messageWith([EMOJI]) } }) },
  };
  const sync = create({ client, emojiId: EMOJI });
  await sync.reconcile();
  await sync.onReaction(reaction(CARD, EMOJI, messageWith([])));
  await sync.onDeleted({ messageIds: [CARD] });
  await sync.onDeleted({ channelId: 'thread-1' });

  assert.deepEqual(queries.mock.calls.map(({ arguments: args }) => args[1]), [
    undefined, // list cards
    [CARD, true], // reconcile approval
    [CARD], // identify a card reaction
    [CARD, false], // reaction removed
    [[CARD], null], // post deleted
    [[], 'thread-1'], // thread deleted
  ]);
  assert.equal(console.error.mock.callCount(), 0);
});

test('a :staffapproved: on a card post approves it', async () => {
  const store = fakeStore();
  await create({ emojiId: EMOJI, store }).onReaction(reaction(CARD, EMOJI, messageWith([EMOJI])));
  assert.deepEqual(store.writes, [[CARD, true]]);
});

test('removing one :staffapproved: keeps approval while another remains', async () => {
  const store = fakeStore();
  const sync = create({ emojiId: EMOJI, store });
  await sync.onReaction(reaction(CARD, EMOJI, messageWith([EMOJI, '111'])));
  await sync.onReaction(reaction(CARD, EMOJI, messageWith(['111'])));
  assert.deepEqual(store.writes, [[CARD, true], [CARD, false]]);
});

test('other emoji and non-card messages never fetch or write', async () => {
  const store = fakeStore();
  const sync = create({ emojiId: EMOJI, store });
  const other = reaction(CARD, '111', messageWith([EMOJI]));
  const notCard = reaction('901', EMOJI, messageWith([EMOJI]));
  const unicode = reaction(CARD, null, messageWith([EMOJI]));
  await sync.onReaction(other);
  await sync.onReaction(notCard);
  await sync.onReaction(unicode);
  assert.equal(other.message.fetch.mock.callCount(), 0);
  assert.equal(notCard.message.fetch.mock.callCount(), 0);
  assert.deepEqual(store.writes, []);
});

test('a deleted card post is unapproved; a transient error writes nothing', async () => {
  const store = fakeStore();
  const sync = create({ emojiId: EMOJI, store });
  await sync.onReaction(reaction(CARD, EMOJI, new Error('503')));
  assert.deepEqual(store.writes, []);
  await sync.onReaction(reaction(CARD, EMOJI, notFound()));
  assert.deepEqual(store.writes, [[CARD, false]]);
});

test('remove-all unapproves', async () => {
  const store = fakeStore();
  await create({ emojiId: EMOJI, store }).onReactionsCleared({ id: CARD });
  assert.deepEqual(store.writes, [[CARD, false]]);
});

test('deleted posts and threads are passed on to unapprove', async () => {
  const store = fakeStore();
  const sync = create({ emojiId: EMOJI, store });
  await sync.onDeleted({ messageIds: [CARD] });
  await sync.onDeleted({ channelId: 'thread-1' });
  assert.deepEqual(store.deleted, [{ messageIds: [CARD] }, { channelId: 'thread-1' }]);
});

test('checks on one message land in event order, even when the first fetch is slow', async () => {
  const store = fakeStore();
  const sync = create({ emojiId: EMOJI, store });
  let release;
  const slow = { emoji: { id: EMOJI }, message: { id: CARD, fetch: () => new Promise((r) => (release = r)) } };
  const added = sync.onReaction(slow); // add: fetch sees the reaction, but slowly
  const removed = sync.onReaction(reaction(CARD, EMOJI, messageWith([]))); // then removed
  await new Promise((r) => setImmediate(r));
  release(messageWith([EMOJI]));
  await Promise.all([added, removed]);
  assert.deepEqual(store.writes, [[CARD, true], [CARD, false]]);
});

for (const gone of [{ messageIds: [CARD] }, { channelId: 'thread-1' }]) {
  test(`deletion wins over a card check already fetching: ${JSON.stringify(gone)}`, async () => {
    const store = fakeStore();
    let approved = false;
    store.setTcgCardApproval = async (_id, value) => { approved = value; };
    store.unapproveDeletedTcgCards = async () => { approved = false; };
    const sync = create({ emojiId: EMOJI, store });
    let release;
    const checking = sync.onReaction({ emoji: { id: EMOJI }, message: {
      id: CARD, channelId: 'thread-1', fetch: () => new Promise((r) => { release = r; }),
    } });
    await new Promise((r) => setImmediate(r));
    const deleting = sync.onDeleted(gone);
    release(messageWith([EMOJI]));
    await Promise.all([checking, deleting]);
    assert.equal(approved, false);
  });
}

test('startup reconcile checks every card; gone ones unapproved, failures skipped', async () => {
  const rows = [
    { message_id: 'a', channel_id: 'thread-a' },
    { message_id: 'b', channel_id: 'thread-gone' },
    { message_id: 'c', channel_id: 'thread-flaky' },
  ];
  const store = fakeStore([], rows);
  const client = {
    channels: {
      fetch: async (id) => {
        if (id === 'thread-gone') throw notFound();
        if (id === 'thread-flaky') throw new Error('timeout');
        return { messages: { fetch: async () => messageWith([EMOJI]) } };
      },
    },
  };
  await create({ client, emojiId: EMOJI, store }).reconcile();
  assert.deepEqual(store.writes, [['a', true], ['b', false]]);
  assert.deepEqual(store.listCalls, [{ uncheckedOnly: false }]);
});

test('the new-card sweep asks only for never-checked cards', async () => {
  const store = fakeStore([], []);
  await create({ client: null, emojiId: EMOJI, store }).reconcile({ uncheckedOnly: true });
  assert.deepEqual(store.listCalls, [{ uncheckedOnly: true }]);
});

test('without the emoji configured, everything is a no-op', async () => {
  const store = fakeStore([CARD], [{ message_id: CARD, channel_id: 'x' }]);
  const sync = create({ client: null, emojiId: null, store });
  await sync.onReaction(reaction(CARD, null, messageWith([])));
  await sync.onReactionsCleared({ id: CARD });
  await sync.onDeleted({ messageIds: [CARD] });
  await sync.reconcile();
  sync.start();
  assert.deepEqual(store.writes, []);
  assert.deepEqual(store.listCalls, []);
  assert.deepEqual(store.deleted, []);
});
