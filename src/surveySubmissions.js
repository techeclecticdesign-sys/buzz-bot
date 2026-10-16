// Forwards structured questionnaire submissions from one Discord channel to a
// Google Apps Script web app. The Apps Script endpoint owns Sheet layout and
// styling, while this module only validates and preserves the Discord source.
const DEFAULT_CHANNEL_ID = '1534208635889123548';

function textCandidates(message) {
  const candidates = [];
  if (typeof message?.content === 'string') candidates.push({ source: 'message', text: message.content });
  for (const embed of message?.embeds ?? []) {
    if (typeof embed?.description === 'string') candidates.push({ source: 'embed', text: embed.description });
  }

  // Some bots mirror the same text in content and an embed. Parse it once.
  const seen = new Set();
  return candidates.filter(({ text }) => {
    if (!text.trim() || seen.has(text)) return false;
    seen.add(text);
    return true;
  });
}

// Expected shape:
//   :user: <@123> • <@456>
//
//   ### A question?
//   Answer
//
// The mention line prevents ordinary Markdown headings in this channel from
// being treated as a form submission. Answers are deliberately left untouched
// other than surrounding whitespace so later Sheet-side parsing loses nothing.
function parseSubmissionText(text) {
  if (typeof text !== 'string') return null;
  const normalized = text.replace(/\r\n?/g, '\n');
  const headers = [...normalized.matchAll(/^###\s+(.+?)\s*$/gm)];
  if (headers.length === 0) return null;

  const preamble = normalized.slice(0, headers[0].index);
  const respondentIds = [...preamble.matchAll(/<@!?(\d{3,22})>/g)].map((match) => match[1]);
  if (respondentIds.length === 0) return null;

  const questions = headers
    .map((header, index) => ({
      question: header[1].trim(),
      answer: normalized.slice(header.index + header[0].length, headers[index + 1]?.index).trim(),
    }))
    .filter(({ question }) => question.length > 0);
  if (questions.length === 0) return null;

  return { respondentIds, questions, rawText: normalized.trim() };
}

function messageTimestamp(message) {
  const created = message?.createdAt;
  if (created instanceof Date && !Number.isNaN(created.valueOf())) return created.toISOString();
  return new Date().toISOString();
}

function makePayload(message, parsed, source) {
  return {
    schemaVersion: 1,
    submissionId: message.id,
    receivedAt: messageTimestamp(message),
    source,
    discord: {
      guildId: message.guildId ?? null,
      channelId: message.channelId,
      messageId: message.id,
      messageUrl: message.url ?? null,
      authorId: message.author?.id ?? null,
      authorUsername: message.author?.username ?? null,
    },
    respondentIds: parsed.respondentIds,
    questions: parsed.questions,
    rawText: parsed.rawText,
  };
}

function create({
  channelId = (process.env.SURVEY_SUBMISSION_CHANNEL_ID || DEFAULT_CHANNEL_ID).trim(),
  webAppUrl = (process.env.SURVEY_SHEETS_WEB_APP_URL || '').trim(),
  sharedSecret = process.env.SURVEY_SHEETS_SHARED_SECRET || '',
  fetchImpl = globalThis.fetch,
  logger = console,
} = {}) {
  const enabled = Boolean(channelId && webAppUrl && sharedSecret && typeof fetchImpl === 'function');
  const inFlightMessageIds = new Set();

  async function postSubmission(submission) {
    const response = await fetchImpl(webAppUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: sharedSecret, submission }),
      redirect: 'follow',
    });
    let detail = '';
    try {
      detail = (await response?.text?.())?.slice(0, 300) ?? '';
    } catch {
      // The status still gives the useful part of this error.
    }
    if (!response?.ok) {
      throw new Error(`Apps Script returned HTTP ${response?.status ?? 'unknown'}${detail ? `: ${detail}` : ''}`);
    }

    // Apps Script ContentService responses use HTTP 200 even when the function
    // rejects an invalid secret, so inspect its small JSON acknowledgement too.
    if (detail) {
      try {
        const result = JSON.parse(detail);
        if (result.ok === false) throw new Error(result.error || 'Apps Script rejected the submission');
      } catch (err) {
        if (err instanceof SyntaxError) return; // endpoint returned non-JSON but succeeded
        throw err;
      }
    }
  }

  async function handleMessage(message) {
    if (!enabled || message?.channelId !== channelId) return false;

    const candidate = textCandidates(message).find(({ text }) => parseSubmissionText(text));
    if (!candidate || inFlightMessageIds.has(message.id)) return false;

    const parsed = parseSubmissionText(candidate.text);
    const submission = makePayload(message, parsed, candidate.source);
    inFlightMessageIds.add(message.id);
    try {
      await postSubmission(submission);
      return true;
    } catch (err) {
      // Allow a later retry if Discord re-delivers the event. The Apps Script
      // function also de-duplicates by Discord message id after a successful write.
      inFlightMessageIds.delete(message.id);
      logger.error(`[survey-submissions] failed to forward ${message.id}: ${err.message}`);
      return false;
    }
  }

  return { channelId, webAppUrl, enabled, textCandidates, parseSubmissionText, makePayload, handleMessage };
}

const integration = create();

module.exports = {
  DEFAULT_CHANNEL_ID,
  textCandidates,
  parseSubmissionText,
  makePayload,
  create,
  ...integration,
};
