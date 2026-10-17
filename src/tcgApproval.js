// Keeps tcg_cards.approved (rpc-web's trading cards) in step with each card
// post's :staffapproved: reaction: live from reaction events, re-checked on
// startup for changes made while the bot was offline, and new cards checked
// every few minutes (rpc-web saves the row a moment after posting, so a reaction
// in between isn't seen live). A card whose post or thread is deleted counts as
// unapproved.
//
// create({ client, emojiId, store }) — emojiId null disables it; store defaults
// to the dedicated card store (tests can pass a fake).
const db = require('./db/tcgCards');
const { messageHasReaction } = require('./advertSync');

const NEW_CARD_SWEEP_MS = 10 * 60 * 1000;

// Discord's "unknown message / channel": the card was deleted.
function isGone(err) {
  return err?.status === 404;
}

function create({ client, emojiId, store = db }) {
  // One check at a time per message, so a quick add-then-remove can't land its
  // writes out of order.
  const queues = new Map();
  function queued(messageId, fn) {
    const run = (queues.get(messageId) ?? Promise.resolve()).then(fn);
    const entry = run.catch(() => {}).finally(() => {
      if (queues.get(messageId) === entry) queues.delete(messageId);
    });
    queues.set(messageId, entry);
    return run;
  }

  // Store the post's current state from a fresh fetch: event counts can be stale,
  // and another staff member's :staffapproved: may remain after one is removed.
  function check(messageId, fetchMessage) {
    return queued(messageId, async () => {
      let approved;
      try {
        approved = messageHasReaction(await fetchMessage(), emojiId);
      } catch (err) {
        if (!isGone(err)) throw err;
        approved = false;
      }
      await store.setTcgCardApproval(messageId, approved);
    });
  }

  // Reaction add / remove / remove-emoji. Anything but :staffapproved: on a card
  // post stops at the cheap checks.
  async function onReaction(reaction) {
    if (!emojiId || reaction.emoji?.id !== emojiId) return;
    const message = reaction.message;
    try {
      if (!(await store.isTcgCardMessage(message.id))) return;
      await check(message.id, () => message.fetch(true));
    } catch (err) {
      console.error('[tcg-approval] reaction sync failed:', err.message);
    }
  }

  // Remove-all leaves no :staffapproved:. A no-op for messages that aren't cards.
  async function onReactionsCleared(message) {
    if (!emojiId) return;
    try {
      await queued(message.id, () => store.setTcgCardApproval(message.id, false));
    } catch (err) {
      console.error('[tcg-approval] clear failed:', err.message);
    }
  }

  // A deleted post or thread (a forum thread's delete sends no message delete for
  // its starter post). No-op unless it held an approved card.
  async function onDeleted(gone) {
    if (!emojiId) return;
    try {
      // A fetch made before deletion may still return the old approved post.
      // Let pending writes finish before clearing it. A thread delete can affect
      // any starter post, so wait for all card checks in that case.
      const pending = gone.channelId ? [...queues.values()]
        : (gone.messageIds ?? []).map((id) => queues.get(id)).filter(Boolean);
      await Promise.all(pending);
      await store.unapproveDeletedTcgCards(gone);
    } catch (err) {
      console.error('[tcg-approval] delete sync failed:', err.message);
    }
  }

  // Check every card (startup), or just never-checked ones (the sweep).
  async function reconcile({ uncheckedOnly = false } = {}) {
    if (!emojiId) return;
    let cards;
    try {
      cards = await store.listTcgCards({ uncheckedOnly });
    } catch (err) {
      console.error('[tcg-approval] could not list cards:', err.message);
      return;
    }
    let failed = 0;
    for (const card of cards) {
      try {
        await check(card.message_id, async () => {
          const channel = await client.channels.fetch(card.channel_id);
          return channel.messages.fetch({ message: card.message_id, force: true });
        });
      } catch (err) {
        failed++;
        console.warn(`[tcg-approval] could not check card ${card.message_id}:`, err.message);
      }
    }
    if (cards.length) {
      console.log(`[tcg-approval] checked ${cards.length - failed}/${cards.length} card(s)`);
    }
  }

  // Full check now, then the new-card sweep.
  function start() {
    if (!emojiId) return;
    reconcile();
    const timer = setInterval(() => reconcile({ uncheckedOnly: true }), NEW_CARD_SWEEP_MS);
    timer.unref?.();
  }

  return { onReaction, onReactionsCleared, onDeleted, reconcile, start };
}

module.exports = { create };
