// Compact, DB-storable summary of a message's reactions, in the order Discord
// returns them. Returns null when there are none so the `messages.reactions`
// column stays NULL rather than an empty array.
//
// Shape per entry (matches what rpc-web renders):
//   { id, name, animated, count }
//     id       custom-emoji id, or null for a unicode emoji
//     name     the unicode char (👍) or the custom emoji's name
//     animated true only for animated custom emoji (CDN .gif vs .png)
//     count    total reactors
function reactionSummary(message) {
  const cache = message?.reactions?.cache;
  if (!cache || cache.size === 0) return null;
  const out = [];
  for (const r of cache.values()) {
    const e = r.emoji;
    out.push({
      id: e.id ?? null,
      name: e.name ?? null,
      animated: !!e.animated,
      count: r.count ?? 0,
    });
  }
  return out.length ? out : null;
}

module.exports = { reactionSummary };
