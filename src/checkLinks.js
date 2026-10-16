// Scans the archived (non-deleted) messages of the channels listed in
// LINK_CHECK_CHANNELS for Discord invite links and reports which ones are
// dead. "Dead" means Discord answers Unknown Invite (expired, revoked, or
// never valid — the API doesn't distinguish). Network/rate-limit failures are
// reported separately as unverified rather than guessed either way.
//
// Two ways to run:
//   • `npm run check-links` — standalone one-shot (this file as the entrypoint).
//   • In-process daily — the live bot calls scheduleLinkCheck(client) on ready,
//     so hosts that only run `npm start` (e.g. Wispbyte, no cron) still get an
//     automatic once-a-day sweep. Both paths share runLinkCheck() below.
require('dotenv').config();
const { Client, Events, GatewayIntentBits } = require('discord.js');
const db = require('./db');
const { pool } = db;
const infractionSticky = require('./infractionSticky');
const config = require('./config');
const { rememberBotDelete, forgetBotDelete } = require('./botDeleteAttribution');
// Just for the shared :staffapproved: emoji — the same auto-approval flag the
// advert re-check stamps on a #rule_infractions ping when an ad is fixed. Reused
// here so a fixed dead link / removed duplicate closes its warning ping the same way.
const { SHARED } = require('./advertConfig');

// Grace window (hours) between first warning an author about a dead link and
// deleting the post if it's still dead. 0 disables auto-deletion (warn/report
// only). Auto-deletion additionally requires LINK_CHECK_NOTIFY_CHANNEL_ID, so a
// post is never removed without the author having been warned first.
const GRACE_HOURS = Math.max(0, Number(process.env.LINK_CHECK_GRACE_HOURS ?? 24));

const configured = new Set(config.idList('LINK_CHECK_CHANNELS'));
// When nothing is configured the feature is dormant: the standalone script
// errors out (below), and the scheduled path simply never arms.
const CONFIGURED = configured.size > 0;

// Matches discord.gg/CODE and discord(app).com/invite/CODE. Codes are
// case-sensitive (never lowercased) and must end on a word char, so trailing prose
// punctuation can't leak in and turn a good invite into a false dead flag.
const INVITE_RE =
  /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([\w-]*\w)/gi;

// The invite-lookup endpoint is aggressively rate limited; one lookup per
// second keeps a big scan well under it (discord.js still queues any 429s).
const DELAY_MS = 1000;

// This bot's pings don't feed YAGPDB's infraction count (its triggers skip bot
// messages). Duplicate-server offenses are still enforced (warn, then delete the
// extra copy after the grace window); they just aren't counted toward YAGPDB's
// 14-day advert ban, which lives in YAGPDB's own database.

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Same matching rule as IGNORE_CHANNELS: a channel is included if its own id
// is listed OR a parent is — so a category ID covers every channel (and their
// threads) under it, and a text-channel ID covers its threads.
function isTargeted(channel) {
  if (!channel) return false;
  if (configured.has(channel.id)) return true;
  if (channel.parentId && configured.has(channel.parentId)) return true;
  if (channel.parent?.parentId && configured.has(channel.parent.parentId)) return true;
  return false;
}

// Delete an offending post from its source channel. Returns true when the post
// is gone (including "already deleted"), false on a real failure so the caller
// keeps the grace flag and retries next sweep. Needs Manage Messages.
async function deletePost(client, row, reason) {
  try {
    const channel = await client.channels.fetch(row.channel_id);
    if (!channel?.isTextBased()) return false;
    rememberBotDelete(row.id, reason);
    await channel.messages.delete(row.id);
    return true;
  } catch (err) {
    forgetBotDelete(row.id);
    if (err.code === 10008) return true; // Unknown Message — already gone
    console.error(`  ! delete failed for post ${row.id}: ${err.message}`);
    return false;
  }
}

// The DB is an archive, not proof that the message still says the same thing.
// Before reporting or enforcing link issues, fetch the current Discord message
// and refresh the stored row. If it is gone, mark it deleted. If it cannot be
// checked, skip it without clearing any existing flag so it cannot re-ping later
// as a fresh offense just because this run could not verify it.
async function fetchCurrentPost(client, row) {
  try {
    const channel = await client.channels.fetch(row.channel_id);
    if (!channel?.isTextBased() || !channel.messages) {
      console.warn(`  ! skipping post ${row.id}: channel ${row.channel_id} is not readable.`);
      return { row: null, preserveFlag: true };
    }
    const msg = await channel.messages.fetch(row.id);
    await db.updateContent(msg.id, msg.content ?? '', msg.editedAt ?? null);
    return {
      row: {
        ...row,
        channel_id: msg.channelId ?? row.channel_id,
        author_id: msg.author?.id ?? row.author_id,
        author_tag: msg.author?.tag ?? row.author_tag,
        content: msg.content ?? '',
        created_at: msg.createdAt ?? row.created_at,
      },
      preserveFlag: false,
    };
  } catch (err) {
    if (err.code === 10008) {
      await db.markDeleted(row.id);
      return { row: null, preserveFlag: false };
    }
    console.warn(`  ! skipping post ${row.id}: could not revalidate live content: ${err.message}`);
    return { row: null, preserveFlag: true };
  }
}

async function refreshCurrentPosts(client, rows) {
  const current = [];
  const unverifiedIds = [];
  if (!rows.length) return { rows: current, unverifiedIds };
  console.log(`[check-links] revalidating ${rows.length} archived invite post(s) against Discord.`);
  for (let i = 0; i < rows.length; i++) {
    process.stdout.write(`Revalidating posts: ${i + 1}/${rows.length}\r`);
    const result = await fetchCurrentPost(client, rows[i]);
    if (result.row) current.push(result.row);
    else if (result.preserveFlag) unverifiedIds.push(rows[i].id);
  }
  process.stdout.write('\n');
  return { rows: current, unverifiedIds };
}

const postTime = (row) => (row.created_at ? new Date(row.created_at).getTime() : 0);

// Jump link to a post + how to address its author (mention if we have the id).
// Shared by both sweeps so wording stays identical.
const jumpLink = (guildId, row) => `https://discord.com/channels/${guildId}/${row.channel_id}/${row.id}`;
const mention = (row, fallback) => (row.author_id ? `<@${row.author_id}>` : (row.author_tag ?? fallback));
const DELETE_REASON_TEXT = {
  dead_link: 'Dead link',
  dup_server: 'Server advertised in multiple channels',
};

function deleteReasonText(reason) {
  return DELETE_REASON_TEXT[reason] ?? String(reason).replace(/_/g, ' ');
}

// Resolve one invite code to 'alive' | 'dead' | 'error'. 'dead' is returned ONLY
// for a genuine Unknown Invite (404 / 10006); every other failure is 'error' —
// transient, and never treated as dead, so a network blip or rate limit can never
// drive a deletion. Same classification the discovery sweep's inline loop uses.
async function resolveCode(client, code) {
  try {
    await client.fetchInvite(code);
    return 'alive';
  } catch (err) {
    if (err.code === 10006 || err.status === 404) return 'dead';
    return 'error';
  }
}

// One warn/enforce entry per post that still contains a dead code. `deadline` is
// the tail of the sentence ("within N hours…" vs "as soon as you can"). Shared by
// both sweeps so the ping text and per-post grouping stay identical.
function buildDeadEntries(postsByCode, status, guildId, deadline) {
  const deadPosts = new Map(); // post id -> { row, count }
  for (const [code, posts] of postsByCode) {
    if (status.get(code) !== 'dead') continue;
    for (const row of posts) {
      const entry = deadPosts.get(row.id) ?? { row, count: 0 };
      entry.count++;
      deadPosts.set(row.id, entry);
    }
  }
  return [...deadPosts.values()].map(({ row, count }) => {
    const where = `<#${row.channel_id}>`;
    const what =
      count === 1
        ? `your link in ${where} has expired. Please update it with a valid link`
        : `${count} of your links in ${where} have expired. Please update them with valid links`;
    return {
      row,
      warn:
        `Hi ${mention(row, 'there')}, it looks like ${what} ${deadline}. ` +
        `For your convenience, [here is a link to your post](${jumpLink(guildId, row)}). Thank you!`,
    };
  });
}

// Run one offense type through the warn→grace→delete pipeline. `entries` is a
// list of { row, warn } (pre-built message strings); `reason` keys the
// persisted grace clock so different offenses track independently. Posts past
// the grace window and still in violation are deleted; new offenses are warned
// once. Returns { warned, deleted }. Shared by dead-link and duplicate-server
// enforcement so both behave identically.
async function enforce(
  client,
  channel,
  entries,
  { reason, autoDelete, graceMs, preserveIds = [] }
) {
  const ids = entries.map((e) => e.row.id);
  const flags = await db.getFlaggedPosts(ids, reason);
  const now = Date.now();
  let warned = 0;
  let deleted = 0;
  for (const { row, warn } of entries) {
    const flaggedAt = flags.get(row.id);
    const expired = flaggedAt && now - flaggedAt.getTime() >= graceMs;

    // Past the grace window and still in violation → remove the post silently.
    // No removal notice is posted to the channel (it would call out the member).
    if (autoDelete && expired) {
      const ok = await deletePost(client, row, deleteReasonText(reason));
      if (ok) {
        deleted++;
        await db.clearFlaggedPosts([row.id], reason);
      }
      await sleep(DELAY_MS); // keep the flag on failure so the next sweep retries
      continue;
    }

    // Otherwise warn only on first sighting. Later sweeps keep the persisted
    // grace clock but do not re-ping the author; they either clear when fixed or
    // delete once the grace window has elapsed.
    const firstSighting = !flaggedAt;
    if (firstSighting) await db.flagPost(row.id, reason, row.channel_id, row.author_id);
    if (!firstSighting) continue;
    try {
      const sent = await channel.send({ content: warn, allowedMentions: { parse: ['users'] } });
      // Record the ping for our own expiry sweep (YAGPDB's expiry skips bot posts)
      // and against the flag, so a later sweep can mark it :staffapproved: on fix.
      if (sent) {
        await db.recordInfractionPost(sent.id, sent.channelId).catch(() => {});
        await db.setFlagNotice(row.id, reason, sent.id).catch(() => {});
      }
      warned++;
    } catch (err) {
      console.error(`  ! notify failed for post ${row.id}: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }
  // Un-flag posts no longer in violation (fixed/removed) so a re-offense starts a
  // fresh clock; an empty id set clears every stamp of this reason. Each cleared
  // row is a resolved offense — mark its warning ping :staffapproved: to close it
  // out (the auto-approval the advert re-check does when an edited ad is fixed).
  const resolved = await db.clearResolvedFlaggedPosts([...new Set([...ids, ...preserveIds])], reason);
  await approveResolvedNotices(channel, resolved);
  return { warned, deleted };
}

// Mark the #rule_infractions warning pings of just-resolved posts :staffapproved:.
// `resolved` is the rows clearResolvedFlaggedPosts removed (posts fixed or deleted
// since the last sweep); each may carry the id of the ping we posted when first
// warning. Best-effort, mirroring the advert re-check's approvePing — every failure
// is non-fatal. Skipped when the notify channel is off, the emoji is unset, or a row
// predates notice tracking (notice_id NULL). Needs Add Reactions in the channel.
async function approveResolvedNotices(channel, resolved) {
  if (!channel?.messages || !SHARED.staffApprovedEmoji || !resolved?.length) return;
  for (const { notice_id: noticeId } of resolved) {
    if (!noticeId) continue;
    const ping = await channel.messages.fetch(noticeId).catch(() => null);
    if (ping) await ping.react(SHARED.staffApprovedEmoji).catch(() => {});
  }
}

// Run one full sweep using an already-connected client. Never logs out, ends
// the pool, or exits — the caller owns the client/process lifecycle (the live
// bot must keep both alive; the standalone wrapper cleans up itself).
async function runLinkCheck(client) {
  if (!CONFIGURED) {
    console.warn('[check-links] LINK_CHECK_CHANNELS is empty — nothing to scan.');
    return;
  }
  console.log('[check-links] resolving channels.');

  // guild_id isn't stored per message (single-server bot); take it from the one
  // guild we're in to build jump links.
  const guildId = client.guilds.cache.first()?.id;

  // Expand the configured IDs into concrete message-holding channel ids, and
  // record names for the report. Threads are enumerated so a targeted category
  // or text channel also covers the threads under it — only for targeted
  // channels, since a thread listed directly in LINK_CHECK_CHANNELS is already
  // covered by the raw-id inclusion below, and every thread of a targeted
  // channel is itself targeted by the parentage rule.
  const names = new Map();
  const channelIds = new Set(configured); // deleted channels/threads still get scanned by raw id
  for (const guild of client.guilds.cache.values()) {
    const channels = await guild.channels.fetch();
    for (const channel of channels.values()) {
      if (!channel) continue;
      names.set(channel.id, channel.name);
      if (!isTargeted(channel)) continue;
      if (channel.isTextBased() || channel.isThreadOnly()) channelIds.add(channel.id);
      if (!channel.threads) continue;
      try {
        const active = await channel.threads.fetchActive();
        for (const thread of active.threads.values()) {
          names.set(thread.id, thread.name);
          channelIds.add(thread.id);
        }
        // fetchArchived pages 100 at a time (newest first) — walk all pages,
        // or old threads (e.g. aged-out forum ads) would be missed. Pagination
        // is by archive timestamp, same as backfill.js.
        let before;
        for (;;) {
          const { threads, hasMore } = await channel.threads.fetchArchived({ before, limit: 100 });
          for (const thread of threads.values()) {
            names.set(thread.id, thread.name);
            channelIds.add(thread.id);
          }
          before = threads.last()?.archivedAt;
          if (!hasMore || threads.size === 0 || !before) break;
        }
      } catch {
        // no thread access — the parent channel is still scanned
      }
    }
  }

  const { rows: archivedRows } = await pool.query(
    `SELECT id, channel_id, author_id, author_tag, content, created_at
     FROM messages
     WHERE channel_id = ANY($1) AND deleted_at IS NULL
       AND (content ILIKE '%discord.gg/%' OR content ILIKE '%discord.com/invite/%'
            OR content ILIKE '%discordapp.com/invite/%')
     ORDER BY channel_id, created_at`,
    [[...channelIds]]
  );
  const { rows, unverifiedIds } = await refreshCurrentPosts(client, archivedRows);

  // One lookup per unique code, however many posts contain it.
  const postsByCode = new Map();
  let postsWithCodes = 0;
  for (const row of rows) {
    const codes = new Set([...row.content.matchAll(INVITE_RE)].map((m) => m[1]));
    if (codes.size) postsWithCodes++;
    for (const code of codes) {
      if (!postsByCode.has(code)) postsByCode.set(code, []);
      postsByCode.get(code).push(row);
    }
  }

  const codes = [...postsByCode.keys()];
  console.log(
    `Found ${codes.length} unique invite code(s) in ${postsWithCodes} current post(s) across ${channelIds.size} channel id(s).`
  );

  const status = new Map(); // code -> 'alive' | 'dead' | 'error: ...'
  const guildByCode = new Map(); // code -> guild id, for live server invites only
  for (let i = 0; i < codes.length; i++) {
    const code = codes[i];
    process.stdout.write(`Checking invites: ${i + 1}/${codes.length}\r`);
    try {
      const invite = await client.fetchInvite(code);
      status.set(code, 'alive');
      // Same call the dead/alive check uses — capture which server it points to
      // so the same-server-in-multiple-channels rule can group by guild, even
      // when two channels use different invite codes for the same server.
      if (invite.guild?.id) guildByCode.set(code, invite.guild.id);
    } catch (err) {
      if (err.code === 10006 || err.status === 404) status.set(code, 'dead');
      else status.set(code, `error: ${err.message}`);
    }
    if (i < codes.length - 1) await sleep(DELAY_MS);
  }
  if (codes.length) process.stdout.write('\n');

  // Outage guard: during a Discord outage, lookups fail across the board (even good
  // links return "Unknown Invite"). If ≥¾ of lookups fail, assume Discord is broken,
  // not the links: the report still prints, but no notifications are posted.
  let failedLookups = 0;
  for (const s of status.values()) if (s !== 'alive') failedLookups++;
  const outageSuspected = codes.length > 0 && failedLookups / codes.length >= 3 / 4;
  if (outageSuspected) {
    console.warn(
      `\n!!! ${failedLookups} of ${codes.length} lookups failed — this looks like a Discord ` +
        'outage, not mass link death. Treat the report below as suspect; no notifications ' +
        'will be posted. Re-run once Discord is healthy.'
    );
  }

  // Report dead invites grouped by channel, each occurrence with a jump link.
  const deadByChannel = new Map();
  const unverified = [];
  let deadCodes = 0;
  for (const [code, posts] of postsByCode) {
    const s = status.get(code);
    if (s === 'alive') continue;
    if (s !== 'dead') {
      unverified.push(`${code} (${s})`);
      continue;
    }
    deadCodes++;
    for (const row of posts) {
      if (!deadByChannel.has(row.channel_id)) deadByChannel.set(row.channel_id, []);
      deadByChannel.get(row.channel_id).push({ code, row });
    }
  }

  if (deadCodes === 0) {
    console.log('No dead invites found.');
  } else {
    console.log(`\n=== ${deadCodes} dead invite code(s) ===`);
    const sorted = [...deadByChannel.entries()].sort(([a], [b]) =>
      (names.get(a) ?? a).localeCompare(names.get(b) ?? b)
    );
    for (const [channelId, entries] of sorted) {
      console.log(`\n#${names.get(channelId) ?? channelId} — ${entries.length} dead link(s)`);
      for (const { code, row } of entries) {
        const when = row.created_at ? row.created_at.toISOString().slice(0, 10) : 'unknown date';
        console.log(
          `  discord.gg/${code} — ${row.author_tag ?? 'unknown author'}, posted ${when}\n` +
            `    https://discord.com/channels/${guildId}/${row.channel_id}/${row.id}`
        );
      }
    }
  }
  if (unverified.length) {
    console.log(`\nCould not verify ${unverified.length} code(s) — re-run to retry:`);
    for (const u of unverified) console.log(`  ${u}`);
  }

  // Enforcement: warn authors and, once a post has been in violation past the
  // grace window, delete it. Two offense types share one pipeline (enforce):
  // dead invite links, and the same server advertised in more than one channel.
  // Requires LINK_CHECK_NOTIFY_CHANNEL_ID so nothing is removed without a warning
  // first, and is skipped entirely during a suspected Discord outage (guard above).
  const notifyChannelId = (process.env.LINK_CHECK_NOTIFY_CHANNEL_ID || '').trim();
  if (notifyChannelId && !outageSuspected) {
    let channel = null;
    try {
      channel = await client.channels.fetch(notifyChannelId);
    } catch {
      // fall through to the error below
    }
    if (!channel?.isTextBased()) {
      console.error(
        `\nCannot enforce: notify channel ${notifyChannelId} not found or not text-based.`
      );
    } else {
      const graceMs = GRACE_HOURS * 60 * 60 * 1000;
      const autoDelete = GRACE_HOURS > 0;
      const deadline = autoDelete
        ? `within ${GRACE_HOURS} hours or it will be removed`
        : 'as soon as you can';

      // --- Dead links: one entry per post with a dead invite ---
      const deadEntries = buildDeadEntries(postsByCode, status, guildId, deadline);

      // --- Duplicate servers: a live server advertised in more than one channel.
      // Group live invites by their resolved guild id (so different invite codes
      // for the same server still count), keep the newest post's channel, and
      // flag every copy in a different channel.
      const byGuild = new Map(); // guild id -> Map(post id -> row)
      for (const [code, posts] of postsByCode) {
        if (status.get(code) !== 'alive') continue;
        const gid = guildByCode.get(code);
        if (!gid) continue; // couldn't resolve a server (e.g. group-DM invite)
        let m = byGuild.get(gid);
        if (!m) byGuild.set(gid, (m = new Map()));
        for (const row of posts) m.set(row.id, row);
      }
      const dupEntries = [];
      for (const m of byGuild.values()) {
        const posts = [...m.values()];
        if (new Set(posts.map((r) => r.channel_id)).size < 2) continue; // only one channel — fine
        // Keep the newest post's channel; every copy elsewhere is a violation.
        const keeper = posts.reduce((a, b) => (postTime(a) >= postTime(b) ? a : b));
        for (const row of posts) {
          if (row.channel_id === keeper.channel_id) continue;
          dupEntries.push({
            row,
            warn:
              `Hi ${mention(row, 'there')}, your server is advertised in more than one channel. ` +
              `Group servers may only be advertised in one channel at a time, so please remove ` +
              `this post in <#${row.channel_id}> ${deadline} — your more recent post in ` +
              `<#${keeper.channel_id}> can stay. [Here is a link to this post](${jumpLink(guildId, row)}). Thank you!`,
          });
        }
      }

      // Both notify then delete after grace. Neither raises a YAGPDB infraction
      // count (YAGPDB can't see our bot posts — see the note at the top).
      const dead = await enforce(client, channel, deadEntries, {
        reason: 'dead_link',
        autoDelete,
        graceMs,
        preserveIds: unverifiedIds,
      });
      const dup = await enforce(client, channel, dupEntries, {
        reason: 'dup_server',
        autoDelete,
        graceMs,
        preserveIds: unverifiedIds,
      });
      console.log(
        `Enforcement (grace ${GRACE_HOURS}h${autoDelete ? '' : ', deletion off'}): ` +
          `dead links ${dead.warned} warned / ${dead.deleted} removed; ` +
          `duplicate servers ${dup.warned} warned / ${dup.deleted} removed.`
      );
      // Re-stick the sticky under this sweep's pings (once per sweep, only when we
      // posted). YAGPDB won't — its triggers skip bot posts.
      if (dead.warned + dup.warned > 0) await infractionSticky.reassertBelow(channel);
    }
  }
}

// --- Hourly pending re-check -------------------------------------------------
// runLinkCheck is the daily DISCOVERY sweep (expensive: one lookup per code). This
// cheap hourly pass re-tests ONLY the already-flagged `dead_link` posts so a fixed
// link clears and a post past its grace window is removed without waiting a day. It
// scans no channels and never issues a first warning (discovery did that), reusing
// enforce(). dup_server is left to the daily sweep (it needs the cross-channel
// keeper picture this pass doesn't gather).
async function runPendingLinkRecheck(client) {
  if (!CONFIGURED) return;
  const graceMs = GRACE_HOURS * 60 * 60 * 1000;
  const autoDelete = GRACE_HOURS > 0;
  // With deletion off there's nothing time-sensitive to do between daily sweeps:
  // a fixed link still clears on the next daily pass, and nothing is ever removed.
  if (!autoDelete) return;

  const flagged = await db.getFlaggedPostsByReason('dead_link');
  if (!flagged.length) return;

  const guildId = client.guilds.cache.first()?.id;

  // Re-validate just the flagged posts against live Discord. This refreshes the
  // archived content, marks any now-deleted post, and returns posts we couldn't
  // read as unverified (their flag is preserved rather than cleared).
  const seedRows = flagged.map((f) => ({
    id: f.message_id,
    channel_id: f.channel_id,
    author_id: f.author_id,
  }));
  const { rows, unverifiedIds } = await refreshCurrentPosts(client, seedRows);

  // Look up only the codes these posts still contain (one throttled lookup each).
  const postsByCode = new Map();
  for (const row of rows) {
    const codes = new Set([...row.content.matchAll(INVITE_RE)].map((m) => m[1]));
    for (const code of codes) {
      if (!postsByCode.has(code)) postsByCode.set(code, []);
      postsByCode.get(code).push(row);
    }
  }
  const codes = [...postsByCode.keys()];
  const status = new Map();
  for (let i = 0; i < codes.length; i++) {
    status.set(codes[i], await resolveCode(client, codes[i]));
    if (i < codes.length - 1) await sleep(DELAY_MS);
  }

  // Preserve the flag on any post whose lookup errored this run (transient / rate
  // limit / outage) so a temporary failure never clears the grace clock or lets
  // the post drop out of the "still dead" set. A real outage makes every lookup
  // 'error', so nothing is deleted — no separate outage guard is needed here (the
  // discovery sweep needs one only because it decides on many codes at once).
  const preserveIds = [...unverifiedIds];
  for (const [code, posts] of postsByCode) {
    if (status.get(code) === 'error') for (const r of posts) preserveIds.push(r.id);
  }

  // The notify channel is only needed to warn a first-sighting — which shouldn't
  // happen here since every post already carries a flag — but fetch it so the rare
  // recovered-flag case still lands correctly (and the sticky can be reasserted).
  const notifyChannelId = (process.env.LINK_CHECK_NOTIFY_CHANNEL_ID || '').trim();
  const channel = notifyChannelId
    ? await client.channels.fetch(notifyChannelId).catch(() => null)
    : null;

  // Outage guard for deletions. The daily sweep uses a fraction-of-failures
  // heuristic, but that's useless here (the flagged set is mostly-dead by
  // definition). Instead: a genuinely dead link returns a clean 404, whereas broad
  // Discord trouble sprays timeouts/500s — and, per the July 2026 outage, can even
  // make GOOD links answer "Unknown Invite" (→ 'dead'). So if ANY lookup errored
  // this run, hold off on deletions and retry next hour rather than risk removing a
  // post the member just fixed. Clearing fixed posts still proceeds — an 'alive'
  // result is a real success and safe to trust even in a flaky run.
  const cleanRun = ![...status.values()].includes('error');
  const deadline = `within ${GRACE_HOURS} hours or it will be removed`;
  const deadEntries = buildDeadEntries(postsByCode, status, guildId, deadline);
  const dead = await enforce(client, channel, deadEntries, {
    reason: 'dead_link',
    autoDelete: autoDelete && cleanRun,
    graceMs,
    preserveIds,
  });
  if (dead.warned + dead.deleted > 0) {
    console.log(
      `[check-links] pending re-check: ${flagged.length} tracked, ` +
        `${dead.warned} warned / ${dead.deleted} removed.`
    );
    if (dead.warned > 0 && channel) await infractionSticky.reassertBelow(channel);
  } else if (!cleanRun) {
    console.warn(
      `[check-links] pending re-check: held deletions this run (${flagged.length} tracked) — ` +
        'a lookup errored, so Discord may be flaky. Will retry next cycle.'
    );
  }
}

// --- Daily in-process scheduler (for hosts with no cron, e.g. Wispbyte) ---
// Fires once a day at TARGET_HOUR UTC. A wall-clock target + an "already ran today"
// guard keep it to one run per calendar day across restarts (a notify run pings
// authors, so it must not re-fire). Set LINK_CHECK_HOUR to change the hour.
const TARGET_HOUR = config.num('LINK_CHECK_HOUR', 4, { min: 0, max: 23 });
const POLL_MS = 30 * 60 * 1000; // check the clock twice an hour
// Hourly pending re-check cadence. Clamped to at least 15 min so it can't be set
// so tight it hammers the invite-lookup rate limit. Set LINK_CHECK_PENDING_MINS.
const PENDING_POLL_MS =
  config.num('LINK_CHECK_PENDING_MINS', 60, { min: 15 }) * 60 * 1000;
let lastRunDate = null; // 'YYYY-MM-DD' of the last completed sweep
let running = false; // a full discovery sweep is in progress
let pendingRunning = false; // an hourly pending re-check is in progress

function scheduleLinkCheck(client) {
  if (!CONFIGURED) {
    console.log('[check-links] disabled (LINK_CHECK_CHANNELS unset).');
    return;
  }
  const tick = async () => {
    if (running || pendingRunning) return; // never overlap the two throttled passes
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    if (now.getUTCHours() !== TARGET_HOUR || lastRunDate === today) return;
    running = true;
    lastRunDate = today; // claim the day up front so a slow run can't double-fire
    try {
      await runLinkCheck(client);
    } catch (err) {
      console.error('[check-links] scheduled run failed:', err.message);
    } finally {
      running = false;
    }
  };
  setInterval(tick, POLL_MS).unref?.();

  // Hourly pending re-check (only useful when grace deletion is on); shares the
  // guards above so it never overlaps the daily sweep or itself.
  if (GRACE_HOURS > 0) {
    const pendingTick = async () => {
      if (running || pendingRunning) return;
      pendingRunning = true;
      try {
        await runPendingLinkRecheck(client);
      } catch (err) {
        console.error('[check-links] pending re-check failed:', err.message);
      } finally {
        pendingRunning = false;
      }
    };
    setInterval(pendingTick, PENDING_POLL_MS).unref?.();
  }
  const notify = (process.env.LINK_CHECK_NOTIFY_CHANNEL_ID || '').trim();
  const enforcement =
    GRACE_HOURS > 0 && notify
      ? `warn then delete after ${GRACE_HOURS}h`
      : GRACE_HOURS > 0 && !notify
        ? 'report only (deletion needs LINK_CHECK_NOTIFY_CHANNEL_ID)'
        : notify
          ? 'warn only (LINK_CHECK_GRACE_HOURS=0)'
          : 'report only';
  const pending =
    GRACE_HOURS > 0 ? `; pending re-check every ${PENDING_POLL_MS / 60000} min` : '';
  console.log(
    `[check-links] armed — daily around ${String(TARGET_HOUR).padStart(2, '0')}:00 UTC ` +
      `(${configured.size} target(s); ${enforcement}${pending}).`
  );
}

module.exports = { runLinkCheck, runPendingLinkRecheck, scheduleLinkCheck, CONFIGURED };

// Standalone entrypoint: `npm run check-links`. Owns its own client and
// process, so it logs in, runs one sweep, then tears everything down.
if (require.main === module) {
  if (!CONFIGURED) {
    console.error(
      'Set LINK_CHECK_CHANNELS in .env to a comma-separated list of channel and/or category IDs first.'
    );
    process.exit(1);
  }
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });
  client.once(Events.ClientReady, async () => {
    console.log(`Logged in as ${client.user.tag}.`);
    try {
      await db.init(); // ensure schema (flagged_posts) exists when run alone
      await runLinkCheck(client);
    } catch (err) {
      console.error('[check-links]', err.message);
    } finally {
      await pool.end();
      client.destroy();
      process.exit(0);
    }
  });
  process.on('unhandledRejection', (err) => {
    console.error('[unhandled]', err);
    process.exit(1);
  });
  client.login(process.env.DISCORD_TOKEN);
}
