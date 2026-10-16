const TTL_MS = 10 * 60 * 1000;

const attributions = new Map();

function normalizeReason(reason) {
  const text = String(reason ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= 180) return text;
  return `${text.slice(0, 177)}...`;
}

function prune(now = Date.now()) {
  for (const [id, entry] of attributions) {
    if (now - entry.at <= TTL_MS) continue;
    attributions.delete(id);
  }
}

function rememberBotDelete(id, reason, now = Date.now()) {
  const normalized = normalizeReason(reason);
  if (!id || !normalized) return;
  prune(now);
  attributions.set(String(id), { reason: normalized, at: now });
}

function forgetBotDelete(id) {
  if (!id) return;
  attributions.delete(String(id));
}

function consumeBotDelete(id, now = Date.now()) {
  if (!id) return null;
  prune(now);
  const key = String(id);
  const entry = attributions.get(key);
  if (!entry) return null;
  attributions.delete(key);
  return { reason: entry.reason };
}

module.exports = {
  TTL_MS,
  rememberBotDelete,
  forgetBotDelete,
  consumeBotDelete,
  // exposed for tests
  _attributions: attributions,
  _normalizeReason: normalizeReason,
};
