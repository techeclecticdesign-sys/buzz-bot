// Resolves "who deleted this message" from the audit log (the delete event doesn't
// say). A mod's repeated deletes bump a counter on one entry, so we track per-entry
// counts to catch increments. No entry = author self-delete OR bot delete (Discord
// audits neither, discord-api-docs #1611), so those two are indistinguishable.
const { AuditLogEvent } = require('discord.js');
const { sleep } = require('./util');

const auditCounts = new Map();

// Cap on retained audit-entry counters, evicting the least-recently-updated
// first. Deleting before re-setting moves an updated key to the back of the
// Map's insertion order, so an entry still being incremented (a mod repeatedly
// deleting the same user/channel) is never the one evicted.
const AUDIT_COUNTS_CAP = 1000;
function rememberAuditCount(id, count) {
  auditCounts.delete(id);
  auditCounts.set(id, count);
  if (auditCounts.size > AUDIT_COUNTS_CAP) {
    const excess = auditCounts.size - AUDIT_COUNTS_CAP;
    let i = 0;
    for (const key of auditCounts.keys()) {
      auditCounts.delete(key);
      if (++i >= excess) break;
    }
  }
}

async function findDeleteExecutor(guild, authorId, channelId) {
  if (!guild || !authorId) return undefined; // can't match → unknown
  try {
    // The audit entry can lag the gateway event by several seconds, so wait
    // long enough that a real mod-delete entry has landed before we conclude
    // there's no entry (which we can't tell apart from an author/bot delete).
    await sleep(4500);
    const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 10 });
    for (const entry of logs.entries.values()) {
      const count = entry.extra?.count ?? 1;
      const prev = auditCounts.get(entry.id);
      rememberAuditCount(entry.id, count);
      if (entry.targetId !== authorId || entry.extra?.channel?.id !== channelId) continue;
      const fresh = Date.now() - entry.createdTimestamp < 10_000;
      const incremented = prev !== undefined && count > prev;
      if (fresh || incremented) return entry.executor;
    }
    return null; // no matching entry → author self-delete or bot delete (Discord audits neither)
  } catch (err) {
    console.error('[audit] fetch failed (missing View Audit Log permission?):', err.message);
    return undefined;
  }
}

// Prime audit counters on startup so deletes right after a restart aren't misread
// as self-deletes when a mod's existing audit entry gets incremented.
async function primeAuditCounts(guild) {
  const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 50 });
  for (const entry of logs.entries.values()) {
    rememberAuditCount(entry.id, entry.extra?.count ?? 1);
  }
}

module.exports = {
  AUDIT_COUNTS_CAP,
  rememberAuditCount,
  findDeleteExecutor,
  primeAuditCounts,
  // exposed for tests
  _auditCounts: auditCounts,
};
