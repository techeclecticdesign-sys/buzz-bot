const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseEmojiId, messageHasReaction } = require('./advertSync');

test('parseEmojiId pulls the id from name:id and <:name:id> forms', () => {
  assert.equal(parseEmojiId('staffapproved:1358879847664975902'), '1358879847664975902');
  assert.equal(parseEmojiId('<:staffapproved:1358879847664975902>'), '1358879847664975902');
  assert.equal(parseEmojiId('<a:spin:1234567890>'), '1234567890');
  assert.equal(parseEmojiId(null), null);
  assert.equal(parseEmojiId(''), null);
  assert.equal(parseEmojiId('👍'), null); // a unicode emoji has no id
});

// Minimal stand-in for discord.js reactions.cache (a Collection extends Map).
function msgWithReactionIds(ids) {
  return { reactions: { cache: new Map(ids.map((id, i) => [String(i), { emoji: { id } }])) } };
}

test('messageHasReaction finds a custom-emoji id in the cache', () => {
  const msg = msgWithReactionIds(['111', '1358879847664975902', '222']);
  assert.equal(messageHasReaction(msg, '1358879847664975902'), true);
  assert.equal(messageHasReaction(msg, '999'), false);
});

test('messageHasReaction is false for empty / missing caches', () => {
  assert.equal(messageHasReaction(msgWithReactionIds([]), '111'), false);
  assert.equal(messageHasReaction({}, '111'), false);
  assert.equal(messageHasReaction(null, '111'), false);
  assert.equal(messageHasReaction({ reactions: {} }, '111'), false);
});

test('messageHasReaction ignores unicode reactions (null id)', () => {
  const msg = msgWithReactionIds([null]); // a unicode reaction carries id null
  assert.equal(messageHasReaction(msg, '111'), false);
});
