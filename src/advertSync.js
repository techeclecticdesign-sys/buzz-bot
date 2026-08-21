// Keeps the DB copy of GROUP advert posts in sync for the browse site (rpc-web):
// image attachments (bytes + metadata) and the live reaction summary. All of it
// is best-effort — failures are logged, never thrown into the event handlers.
//
// create({ loggingEnabled, advertChannelSet }) injects the two config values the
// reaction sync needs (image sync needs neither). advertChannelSet is the Set of
// advert channel IDs whose reactions we mirror.
const db = require('./db');
const advertImages = require('./advertImages');
const { reactionSummary } = require('./reactions');

function create({ loggingEnabled, advertChannelSet }) {
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
      const images = await advertImages.downloadImages(descriptors);
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
  }

  return { syncAdvertImages, reconcileAdvertImages, syncAdvertReactions, clearAdvertReactions };
}

module.exports = { create };
