'use strict';
const { test } = require('node:test');
const assert = require('node:assert');

const { isOwnInfractionPost } = require('./infractionExpiry');

// The expiry sweep deletes a #rule_infractions message ONLY when this gate says
// it is authored by logger-bot itself. These tests pin that property down: the
// gate must fail CLOSED (return false → do not delete) on anything that isn't
// provably one of our own posts, so a corrupted/mis-recorded ledger row can never
// cause us to delete a human staff infraction note or a YAGPDB ping.
const SELF = 'LOGGER_BOT_ID';

test('deletes our own message', () => {
  assert.equal(isOwnInfractionPost({ author: { id: SELF } }, SELF), true);
});

test('never deletes a YAGPDB / other-bot message', () => {
  assert.equal(isOwnInfractionPost({ author: { id: 'YAGPDB_ID', bot: true } }, SELF), false);
});

test('never deletes a human staff infraction note', () => {
  assert.equal(isOwnInfractionPost({ author: { id: 'HUMAN_STAFF', bot: false } }, SELF), false);
});

test('fails closed when the message is missing', () => {
  assert.equal(isOwnInfractionPost(null, SELF), false);
  assert.equal(isOwnInfractionPost(undefined, SELF), false);
});

test('fails closed when the message has no author', () => {
  assert.equal(isOwnInfractionPost({}, SELF), false);
  assert.equal(isOwnInfractionPost({ author: null }, SELF), false);
});

test('fails closed when our own id is unknown (never delete on ambiguity)', () => {
  assert.equal(isOwnInfractionPost({ author: { id: SELF } }, null), false);
  assert.equal(isOwnInfractionPost({ author: { id: SELF } }, undefined), false);
  assert.equal(isOwnInfractionPost({ author: { id: SELF } }, ''), false);
});
