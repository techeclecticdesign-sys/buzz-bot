// #rule_infractions sticky keeper.
//
// YAGPDB re-posts its "Don't panic!" sticky to the bottom of #rule_infractions on
// every human message, but its triggers skip bot messages — so anything this bot
// posts there (link-check / advert pings) leaves YAGPDB's sticky stranded above.
//
//   reassertBelow(channel): after this bot posts, delete whatever sticky is present
//     (YAGPDB's and/or our prior copycat) and post a fresh copycat at the bottom.
//   handleForeignPost(message): when anyone else posts, delete our copycats and let
//     YAGPDB re-stick its own.
//
// Stickies are matched by embed content (STICKY_FINGERPRINT), not a stored id, so
// cleanup survives restarts and handles duplicate copycats; a per-channel lock
// serialises posters. Bounded by the SCAN_LIMIT fetch window.
//
// SYNC: STICKY_EMBED must match rpc-yagpdb/infractions_sticky/infractions_sticky.go.

const cfg = require('./advertConfig');

// Mirror of the YAGPDB sticky embed (cembed "description" ... "color" ...).
const STICKY_TEXT =
  "Don't panic! If you see your name here, you're not in trouble! There's a mistake in " +
  'your advert that needs updated. You have ~10 hours to edit your advert before it\'s deleted.';
const STICKY_COLOR = 0xf4700f;
const STICKY_EMBED = { description: STICKY_TEXT, color: STICKY_COLOR };

// A distinctive phrase from the sticky, used to recognise a sticky message from
// EITHER bot without depending on the exact full text.
const STICKY_FINGERPRINT = "you're not in trouble";

// Discord's single-fetch max, and a correctness bound: a copycat buried deeper
// than this can't be seen again and orphans. Only possible if one batch posts 100
// pings with no human/YAGPDB message between — implausible here.
const SCAN_LIMIT = 100;

// The channel that carries the sticky: #rule_infractions, from the advert config.
// Deliberately NOT unioned with LINK_CHECK_NOTIFY_CHANNEL_ID — if a deployment
// points that env at some OTHER channel, that channel has no YAGPDB sticky to
// maintain, and reassertBelow must no-op there rather than spam a copycat into
// it. When the notify channel IS #rule_infractions (the normal case) it equals
// this id and everything works; when it differs, reassertBelow(thatChannel)
// correctly does nothing.
const INFRACTION_CHANNEL_IDS = new Set(
  [cfg.SHARED?.infractionsChannelId].filter(Boolean)
);

// Per-channel serialisation: reassert (posting a copycat) and cleanup (deleting
// copycats) must never interleave, and two concurrent posters must not each post
// a copycat. Each call chains onto the channel's tail promise so they run
// strictly one at a time. The stored tail is error-swallowed so one failure
// can't wedge the queue; callers still see their own rejection.
const locks = new Map();
function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(() => fn());
  locks.set(key, run.catch(() => {}));
  return run;
}

function isInfractionChannel(channelId) {
  return INFRACTION_CHANNEL_IDS.has(channelId);
}

// A sticky message from EITHER bot (YAGPDB's real one or a copycat of ours).
function isStickyMessage(msg) {
  if (!msg?.author?.bot) return false;
  const desc = msg.embeds?.[0]?.description || '';
  return desc.includes(STICKY_FINGERPRINT);
}

// After logger-bot posts into an infraction channel: clear every sticky present
// (YAGPDB's stranded one and any stale copycat) and drop a fresh copycat at the
// bottom. Safe to call once per posting event; do NOT call per-ping in a loop.
async function reassertBelow(channel) {
  if (!channel?.isTextBased?.() || !isInfractionChannel(channel.id)) return;
  try {
    await withLock(channel.id, async () => {
      const recent = await channel.messages.fetch({ limit: SCAN_LIMIT });
      for (const m of recent.values()) {
        if (isStickyMessage(m)) await m.delete().catch(() => {});
      }
      await channel.send({ embeds: [STICKY_EMBED], allowedMentions: { parse: [] } });
    });
  } catch (err) {
    console.error(`[infr-sticky] reassert failed in ${channel.id}: ${err.message}`);
  }
}

// From messageCreate: any post by someone other than logger-bot in an infraction
// channel means YAGPDB owns the sticky again — delete EVERY copycat of ours that
// remains (content-detected, so this survives restarts and clears duplicates).
// Never touches YAGPDB's own sticky.
async function handleForeignPost(message) {
  if (!isInfractionChannel(message.channelId)) return;
  const meId = message.client.user?.id;
  if (!meId || message.author?.id === meId) return; // our own infraction/copycat
  const channel = message.channel;
  if (!channel?.messages?.fetch) return;
  try {
    await withLock(channel.id, async () => {
      const recent = await channel.messages.fetch({ limit: SCAN_LIMIT });
      for (const m of recent.values()) {
        if (m.author?.id === meId && isStickyMessage(m)) await m.delete().catch(() => {});
      }
    });
  } catch (err) {
    console.error(`[infr-sticky] cleanup failed in ${channel.id}: ${err.message}`);
  }
}

module.exports = {
  reassertBelow,
  handleForeignPost,
  isInfractionChannel,
  isStickyMessage,
  STICKY_EMBED,
  INFRACTION_CHANNEL_IDS,
};
