'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

// The module reads the infraction channel id from advertConfig at require-time;
// the live #rule_infractions id is used so the fake channel matches.
const CH = '641835326314381312';
const LOGGER = 'LOGGER';
const YAG = 'YAG';
const HUMAN = 'HUMAN';

const sticky = require('./infractionSticky');

const STICKY_DESC = sticky.STICKY_EMBED.description;

let seq = 0;
function makeMsg(channel, authorId, { sticky: isSticky = false, bot = true } = {}) {
  const msg = {
    id: `m${++seq}`,
    author: { id: authorId, bot: authorId === LOGGER || authorId === YAG ? true : bot },
    embeds: isSticky ? [{ description: STICKY_DESC }] : [],
    channel,
    client: { user: { id: LOGGER } },
    channelId: channel.id,
    async delete() {
      const i = channel.store.indexOf(msg);
      if (i >= 0) channel.store.splice(i, 1);
    },
  };
  return msg;
}

function makeChannel() {
  const channel = {
    id: CH,
    store: [], // oldest-first
    isTextBased: () => true,
    messages: {
      async fetch({ limit }) {
        // newest-first snapshot (a copy, so deletes during iteration are safe)
        const snap = channel.store.slice(-limit).reverse();
        return new Map(snap.map((m) => [m.id, m]));
      },
    },
    async send({ embeds }) {
      const m = makeMsg(channel, LOGGER, { sticky: embeds?.[0]?.description === STICKY_DESC });
      channel.store.push(m);
      return m;
    },
  };
  return channel;
}

const post = (channel, authorId, opts) => {
  const m = makeMsg(channel, authorId, opts);
  channel.store.push(m);
  return m;
};
const copycats = (channel) =>
  channel.store.filter((m) => m.author.id === LOGGER && sticky.isStickyMessage(m));
const stickies = (channel) => channel.store.filter((m) => sticky.isStickyMessage(m));

test('restart orphan: a foreign post cleans a copycat even with no in-memory state', async () => {
  const ch = makeChannel();
  post(ch, HUMAN, { bot: false }); // some prior message
  post(ch, LOGGER, { sticky: true }); // orphaned copycat left before a restart

  const human = post(ch, HUMAN, { bot: false }); // human posts after "restart"
  await sticky.handleForeignPost(human);

  assert.equal(copycats(ch).length, 0, 'our copycat should be deleted with no remembered id');
});

test('concurrent reasserts leave exactly one copycat (no double)', async () => {
  const ch = makeChannel();
  post(ch, YAG, { sticky: true }); // YAGPDB's real sticky
  post(ch, LOGGER, { bot: true }); // our infraction ping

  await Promise.all([sticky.reassertBelow(ch), sticky.reassertBelow(ch)]);

  assert.equal(stickies(ch).length, 1, 'exactly one sticky total');
  assert.equal(copycats(ch).length, 1, 'the surviving sticky is our copycat');
  assert.equal(ch.store[ch.store.length - 1].author.id, LOGGER, 'copycat is the bottom message');
});

test('normal handoff: reassert sticks under our ping, human post hands back to YAGPDB', async () => {
  const ch = makeChannel();
  post(ch, YAG, { sticky: true }); // YAGPDB sticky at bottom
  post(ch, LOGGER, { bot: true }); // our infraction ping

  await sticky.reassertBelow(ch);
  assert.equal(stickies(ch).length, 1, 'YAGPDB sticky removed, one copycat left');
  assert.equal(copycats(ch).length, 1);

  const human = post(ch, HUMAN, { bot: false });
  await sticky.handleForeignPost(human);
  assert.equal(copycats(ch).length, 0, 'copycat handed back on the human post');
});

test('cleanup never deletes YAGPDB\'s own sticky', async () => {
  const ch = makeChannel();
  const yagSticky = post(ch, YAG, { sticky: true });
  const human = post(ch, HUMAN, { bot: false });

  await sticky.handleForeignPost(human);
  assert.ok(ch.store.includes(yagSticky), 'YAGPDB sticky must survive our cleanup');
});

test('burial: a large ping batch does not strand the prior copycat', async () => {
  const ch = makeChannel();
  post(ch, LOGGER, { sticky: true }); // prior resting copycat at the top
  // A link sweep posts one ping per new offense (30 here) then reasserts ONCE.
  for (let i = 0; i < 30; i++) post(ch, LOGGER, { bot: true });

  await sticky.reassertBelow(ch);

  // The prior copycat sat 31 messages up — past the old 25 window. It must still
  // be found and removed, leaving exactly one copycat, at the bottom.
  assert.equal(copycats(ch).length, 1, 'exactly one copycat after the batch');
  assert.equal(ch.store[ch.store.length - 1].author.id, LOGGER, 'copycat is the bottom message');
});

test('wrong-channel: reassert no-ops on a channel that is not #rule_infractions', async () => {
  const ch = makeChannel();
  ch.id = 'SOME_OTHER_CHANNEL'; // e.g. LINK_CHECK_NOTIFY_CHANNEL_ID pointed elsewhere
  const before = ch.store.length;

  await sticky.reassertBelow(ch);

  assert.equal(ch.store.length, before, 'must not post a sticky into a non-infraction channel');
  assert.equal(sticky.isInfractionChannel('SOME_OTHER_CHANNEL'), false);
});
