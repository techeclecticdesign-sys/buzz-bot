// Channels the logger should skip entirely — no archive, no edit/delete embeds,
// no bulk-delete transcript, and skipped by the backfill too. Set with
// IGNORE_CHANNELS in .env as a comma-separated list of channel IDs.
//
// A channel matches if its own id is listed OR one of its parents is: because a
// thread's parentId is its text channel and a text channel's parentId is its
// category, listing a category excludes every channel (and their threads) under
// it, and listing a text channel excludes its threads. Member/name/role logging
// isn't channel-scoped, so it's unaffected.
const ids = new Set(
  (process.env.IGNORE_CHANNELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

// True if this channel (or its category / thread-parent) is on the ignore list.
// Accepts a discord.js channel; safe to call with null/undefined.
function isIgnoredChannel(channel) {
  if (ids.size === 0 || !channel) return false;
  if (ids.has(channel.id)) return true;
  if (channel.parentId && ids.has(channel.parentId)) return true;
  // A thread's parent is a text channel that may itself sit in an ignored
  // category — walk one more hop when the parent is resolvable.
  if (channel.parent?.parentId && ids.has(channel.parent.parentId)) return true;
  return false;
}

// True if the message's channel is ignored. Falls back to channelId when the
// channel object isn't resolvable (e.g. a delete on an uncached channel).
function isIgnoredMessage(message) {
  if (ids.size === 0) return false;
  if (message.channelId && ids.has(message.channelId)) return true;
  return isIgnoredChannel(message.channel);
}

module.exports = { ids, isIgnoredChannel, isIgnoredMessage };
