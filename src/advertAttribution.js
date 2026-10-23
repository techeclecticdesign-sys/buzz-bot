// Ads posted from rpc-web go out through a webhook, so Discord shows no member
// to message. Each one opens with an attribution: a mention of the poster and a
// subtext line, then a blank line. The archive credits the ad to that member, and checks and the
// site read the ad without it. The format MUST match rpc-web's
// lib/advertAttribution.ts; the pinned cases in advertAttribution.spec.js
// (mirrored there) guard against drift.

const ATTRIBUTION_NOTE = '-# Click the name to message them';
// The blank line after it is optional: the first ads went out without one.
const ATTRIBUTION_RE = /^<@!?(\d{17,20})>\n-# Click the name to message them\n\n?/;

/** The attribution line for a poster, as the ad's opening. */
function attributionFor(userId) {
  return `<@${userId}>\n${ATTRIBUTION_NOTE}\n\n`;
}

/** { authorId, body } for an attributed ad, else null. */
function parseAttribution(content) {
  const m = ATTRIBUTION_RE.exec(content ?? '');
  return m ? { authorId: m[1], body: content.slice(m[0].length) } : null;
}

/** The ad without its attribution (unchanged when it has none). */
function stripAttribution(content) {
  return parseAttribution(content)?.body ?? (content ?? '');
}

/** The member an rpc-web ad credits, when `message` is one: posted by a webhook
 * of this bot's own application, in an advert channel, opening with an
 * attribution. Null for everything else. */
function siteAdvertAuthor(message, applicationId, advertChannelIds) {
  if (!message.webhookId || !applicationId || message.applicationId !== applicationId) return null;
  if (!advertChannelIds.includes(message.channelId)) return null;
  const parsed = parseAttribution(message.content);
  if (!parsed) return null;
  return { id: parsed.authorId, tag: message.author?.username ?? null };
}

module.exports = { attributionFor, parseAttribution, stripAttribution, siteAdvertAuthor };
