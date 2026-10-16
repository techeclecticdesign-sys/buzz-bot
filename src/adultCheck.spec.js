const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CHANNEL_ID, COMMAND, commandData, isAgeRestricted, handleInteraction } = require('./adultCheck');

const user = { id: '111', username: 'someone', displayAvatarURL: () => 'https://cdn.example/a.png' };
const text = (nsfw) => ({ nsfw, isThread: () => false });
const thread = (parentNsfw) => ({ isThread: () => true, parent: text(parentNsfw) });

// Minimal chat-input interaction: records replies and posts to the log channel.
function fakeInteraction({ commandName = COMMAND, channel, inGuild = true } = {}) {
  const sent = [];
  const replies = [];
  const i = {
    commandName,
    channel,
    channelId: '222',
    user,
    replied: false,
    deferred: false,
    isChatInputCommand: () => true,
    inGuild: () => inGuild,
    reply: async (m) => { replies.push(m); i.replied = true; },
    editReply: async (m) => { replies.push(m); },
    client: {
      channels: {
        fetch: async (id) => {
          if (id !== CHANNEL_ID) throw new Error(`unexpected fetch ${id}`);
          return { send: async (m) => { sent.push(m); } };
        },
      },
    },
  };
  return { i, sent, replies };
}

test('command is registered age-restricted', () => {
  const [cmd] = commandData();
  assert.equal(cmd.name, COMMAND);
  assert.equal(cmd.nsfw, true);
});

test('isAgeRestricted: channel flag, threads inherit from parent, missing → false', () => {
  assert.equal(isAgeRestricted(text(true)), true);
  assert.equal(isAgeRestricted(text(false)), false);
  assert.equal(isAgeRestricted(thread(true)), true);
  assert.equal(isAgeRestricted(thread(false)), false);
  assert.equal(isAgeRestricted({ isThread: () => true, parent: null }), false);
  assert.equal(isAgeRestricted(null), false);
});

test('ignores other commands', async () => {
  const { i, sent, replies } = fakeInteraction({ commandName: 'poll', channel: text(true) });
  assert.equal(await handleInteraction(i), false);
  assert.equal(sent.length, 0);
  assert.equal(replies.length, 0);
});

test('refuses outside an age-restricted channel without posting', async () => {
  const { i, sent, replies } = fakeInteraction({ channel: text(false) });
  assert.equal(await handleInteraction(i), true);
  assert.equal(sent.length, 0);
  assert.match(replies[0].content, /age-restricted channel/);
});

test('posts the member to the log channel and confirms ephemerally', async () => {
  const { i, sent, replies } = fakeInteraction({ channel: text(true) });
  assert.equal(await handleInteraction(i), true);
  assert.equal(sent.length, 1);
  const desc = sent[0].embeds[0].data.description;
  assert.match(desc, /<@111>/);
  assert.match(desc, /`someone`/);
  assert.match(desc, /<#222>/);
  assert.match(replies[0].content, /18\+/);
});
