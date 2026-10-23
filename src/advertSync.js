// Keeps the DB copy of GROUP advert posts in sync for the browse site (rpc-web):
// image attachments (bytes + metadata) and the live reaction summary. All of it
// is best-effort — failures are logged, never thrown into the event handlers.
//
// create({ loggingEnabled, advertChannelSet, advertConfig }) injects the config the
// reaction sync needs (image sync needs none). advertChannelSet is the Set of advert
// channel IDs whose reactions we mirror; advertConfig drives the approval-hash
// reconcile (channel type + the :staffapproved: emoji id).
const db = require('./db');
const advertImages = require('./advertImages');
const { reactionSummary } = require('./reactions');
const { advertContentHash } = require('./advertHash');

// Pull the numeric id out of a "name:id" / "<:name:id>" emoji reference.
function parseEmojiId(ref) {
  if (!ref) return null;
  const m = String(ref).match(/(\d{5,})>?$/);
  return m ? m[1] : null;
}

// Does the message currently carry a reaction with this custom-emoji id?
function messageHasReaction(message, emojiId) {
  const cache = message && message.reactions && message.reactions.cache;
  if (!cache) return false;
  for (const r of cache.values()) {
    if (r && r.emoji && r.emoji.id === emojiId) return true;
  }
  return false;
}

function create({ loggingEnabled, advertChannelSet, advertConfig }) {
  // :staffapproved: id, parsed once. Null (reconcile disabled) when no advert
  // config is present — e.g. a game-only / test instance.
  const staffApprovedEmojiId = parseEmojiId(advertConfig && advertConfig.SHARED
    && advertConfig.SHARED.staffApprovedEmoji);

  // group / 1x1 advert channels, but NOT quick (quick posts never get approved).
  function isNonQuickApprovalChannel(channelId) {
    const type = advertConfig && advertConfig.typeForChannel(channelId);
    return !!type && type.name !== 'quick';
  }

  // Keep advert_approval_hashes in step with the post's current :staffapproved:
  // state. Called with an authoritative (refetched) message. Converges to truth on
  // any reaction event, so add / remove / remove-emoji / remove-all all land here.
  async function reconcileApproval(message) {
    if (!staffApprovedEmojiId) return;
    const channelId = message && message.channelId;
    if (!channelId || !isNonQuickApprovalChannel(channelId)) return;
    try {
      const approved = messageHasReaction(message, staffApprovedEmojiId);
      const authorId = message.author && message.author.id;
      const hash = approved ? advertContentHash(message.content) : null;
      if (approved && authorId && hash) {
        await db.upsertApprovedHash(message.id, authorId, hash, channelId);
      } else {
        // Not approved, or nothing to key on (no text / unknown author) → make
        // sure no stale row lingers. DELETE of a missing row is a cheap no-op.
        await db.deleteApprovedHash(message.id);
      }
    } catch (err) {
      console.error('[approvals] reconcile error:', err.message);
    }
  }
  // Persist (or refresh) the stored image attachments for a GROUP advert post so
  // the browse site can show them. No-ops for non-group channels.
  async function syncAdvertImages(message) {
    if (!advertImages.isGroupChannel(message.channelId)) return;
    try {
      const descriptors = advertImages.fromDiscordMessage(message);
      if (descriptors.length === 0) {
        await db.clearAdvertAttachments(message.id);
        return;
      }
      const images = await advertImages.shrinkImages(await advertImages.downloadImages(descriptors));
      await db.setAdvertAttachments(message.id, message.channelId, images);
    } catch (err) {
      console.error('[advert-images] sync error:', err.message);
    }
  }

  // On an edit, re-capture group-ad images only when the image set actually
  // changed versus what's already stored (`stored.attachments` metadata). Handles
  // the attachment-only edit — e.g. removing an image without touching the text —
  // which the content-changed guard alone would miss.
  async function reconcileAdvertImages(message, stored) {
    if (!advertImages.isGroupChannel(message.channelId)) return;
    const current = advertImages.imageSignature(advertImages.fromDiscordMessage(message));
    const previous = advertImages.imageSignature(stored?.attachments);
    if (current !== previous) await syncAdvertImages(message);
  }

  // Refetch the message and rewrite its full reaction summary (a single event only
  // reports one emoji, and partial-event counts can be stale). Advert channels only.
  async function syncAdvertReactions(reaction) {
    if (!loggingEnabled) return;
    const channelId = reaction.message?.channelId;
    if (!channelId || !advertChannelSet.has(channelId)) return;
    let message = reaction.message;
    try {
      message = await message.fetch(); // force-refetch => authoritative reactions
    } catch {
      return; // message deleted before we could read it
    }
    try {
      await db.setReactions(message.id, reactionSummary(message));
    } catch (err) {
      console.error('[reactions] db error:', err.message);
    }
    await reconcileApproval(message);
  }

  // Removing all reactions gives a message, not a reaction — clear the column.
  async function clearAdvertReactions(message) {
    if (!loggingEnabled) return;
    if (!message?.channelId || !advertChannelSet.has(message.channelId)) return;
    try {
      await db.setReactions(message.id, null);
    } catch (err) {
      console.error('[reactions] db error:', err.message);
    }
    // Every reaction is gone, so :staffapproved: is too — drop any stored hash.
    await reconcileApproval(message);
  }

  return { syncAdvertImages, reconcileAdvertImages, syncAdvertReactions, clearAdvertReactions };
}

module.exports = { create, parseEmojiId, messageHasReaction };
