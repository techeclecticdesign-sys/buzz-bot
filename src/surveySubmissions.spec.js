const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create, parseSubmissionText } = require('./surveySubmissions');

const FORM = `:user: <@1437254314434232330> • <@1437254314434232330>

### Would you use it for ads instead of discord?

Yes

### Anything confusing, ugly or hard to use?

ggdgf

### Which features would you use?

gdgfdg`;

test('parseSubmissionText preserves ordered questions, answers, and repeated mention positions', () => {
  const parsed = parseSubmissionText(FORM);
  assert.deepEqual(parsed.respondentIds, ['1437254314434232330', '1437254314434232330']);
  assert.deepEqual(parsed.questions, [
    { question: 'Would you use it for ads instead of discord?', answer: 'Yes' },
    { question: 'Anything confusing, ugly or hard to use?', answer: 'ggdgf' },
    { question: 'Which features would you use?', answer: 'gdgfdg' },
  ]);
  assert.equal(parsed.rawText, FORM);
});

test('parseSubmissionText rejects headings without the form participant line', () => {
  assert.equal(parseSubmissionText('### A normal heading\n\nNot a survey'), null);
});

test('configured integration forwards a structured submission exactly once', async () => {
  const calls = [];
  const integration = create({
    channelId: '1534208635889123548',
    webAppUrl: 'https://script.google.com/macros/s/example/exec',
    sharedSecret: 'test-secret',
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200 };
    },
    logger: { error: () => assert.fail('unexpected forwarding error') },
  });
  const message = {
    id: '123456789012345678',
    channelId: '1534208635889123548',
    guildId: '987654321098765432',
    url: 'https://discord.com/channels/987/153/123',
    content: FORM,
    embeds: [],
    createdAt: new Date('2026-10-02T15:00:00.000Z'),
    author: { id: '222', username: 'form-bot' },
  };

  assert.equal(await integration.handleMessage(message), true);
  assert.equal(await integration.handleMessage(message), false);
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.secret, 'test-secret');
  assert.equal(body.submission.discord.messageId, message.id);
  assert.equal(body.submission.questions.length, 3);
  assert.equal(body.submission.source, 'message');
});

test('configured integration parses form text in an embed description', async () => {
  const calls = [];
  const integration = create({
    channelId: 'target',
    webAppUrl: 'https://script.google.com/macros/s/example/exec',
    sharedSecret: 'test-secret',
    fetchImpl: async (_url, options) => {
      calls.push(JSON.parse(options.body));
      return { ok: true, status: 200 };
    },
  });

  assert.equal(await integration.handleMessage({
    id: 'message', channelId: 'target', embeds: [{ description: FORM }], content: '', author: {},
  }), true);
  assert.equal(calls[0].submission.source, 'embed');
});
