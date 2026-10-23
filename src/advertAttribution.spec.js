const { test } = require('node:test');
const assert = require('node:assert/strict');
const { attributionFor, parseAttribution, stripAttribution, siteAdvertAuthor } = require('./advertAttribution');

// Pinned: rpc-web's lib/advertAttribution.test.ts holds the same cases.
const ID = '376617185033977857';
const AD = 'Looking for a partner!\n\n**Slow burn** please.';

test('attributionFor: the pinned format', () => {
  assert.equal(attributionFor(ID), `<@${ID}>\n-# Click the name to message them\n\n`);
});

test('parseAttribution: round-trips and finds the poster', () => {
  assert.deepEqual(parseAttribution(attributionFor(ID) + AD), { authorId: ID, body: AD });
  assert.deepEqual(parseAttribution(`<@!${ID}>\n-# Click the name to message them\n\n${AD}`), { authorId: ID, body: AD });
  // The first ads had no blank line.
  assert.deepEqual(parseAttribution(`<@${ID}>\n-# Click the name to message them\n${AD}`), { authorId: ID, body: AD });
});

test('parseAttribution: only an exact opening counts', () => {
  assert.equal(parseAttribution(AD), null);
  assert.equal(parseAttribution(`hi <@${ID}>\n-# Click the name to message them\n${AD}`), null);
  assert.equal(parseAttribution(`<@${ID}>\n${AD}`), null);
  assert.equal(parseAttribution(`<@123>\n-# Click the name to message them\n${AD}`), null);
  assert.equal(parseAttribution(''), null);
  assert.equal(parseAttribution(null), null);
});

test('stripAttribution: removes only the attribution', () => {
  assert.equal(stripAttribution(attributionFor(ID) + AD), AD);
  assert.equal(stripAttribution(AD), AD);
  assert.equal(stripAttribution(null), '');
});

test('siteAdvertAuthor: own-app webhook posts in advert channels only', () => {
  const ad = {
    webhookId: '1', applicationId: 'app', channelId: 'c1',
    content: attributionFor(ID) + AD, author: { username: 'Ada' },
  };
  assert.deepEqual(siteAdvertAuthor(ad, 'app', ['c1']), { id: ID, tag: 'Ada' });
  assert.equal(siteAdvertAuthor({ ...ad, webhookId: null }, 'app', ['c1']), null);
  assert.equal(siteAdvertAuthor({ ...ad, applicationId: 'other' }, 'app', ['c1']), null);
  assert.equal(siteAdvertAuthor(ad, 'app', ['c2']), null);
  assert.equal(siteAdvertAuthor({ ...ad, content: AD }, 'app', ['c1']), null);
  assert.equal(siteAdvertAuthor(ad, undefined, ['c1']), null);
});
