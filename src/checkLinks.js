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

// Grace window (hours) between first warning an author about a dead link and
// deleting the post if it's still dead. 0 disables auto-deletion (warn/report
// only). Auto-deletion additionally requires LINK_CHECK_NOTIFY_CHANNEL_ID, so a
// post is never removed without the author having been warned first.
const GRACE_HOURS = Math.max(0, Number(process.env.LINK_CHECK_GRACE_HOURS ?? 24));

const configured = new Set(
  (process.env.LINK_CHECK_CHANNELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);
// When nothing is configured the feature is dormant: the standalone script
// errors out (below), and the scheduled path simply never arms.
const CONFIGURED = configured.size > 0;

// discord.gg/CODE, discord.com/invite/CODE, discordapp.com/invite/CODE.
// Codes are case-sensitive, so the captured code is never lowercased. The
// code class matches discord.js's own invite resolver ([\w-], so underscores
// count) but must end on a word character, so adjacent prose punctuation
// ("discord.gg/abc- best server!") can't leak into the code and turn a good
// invite into a false dead flag.
const INVITE_RE =
  /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/([\w-]*\w)/gi;

// The invite-lookup endpoint is aggressively rate limited; one lookup per
// second keeps a big scan well under it (discord.js still queues any 429s).
const DELAY_MS = 1000;

// Invisible marker (U+2063 INVISIBLE SEPARATOR ×3) appended to a notify-channel
// ping to tell YAGPDB's #rule_infractions counter "log this as an infraction."
// It renders as nothing for members, and no other logger-bot message emits
// U+2063, so its mere presence is an unambiguous signal. YAGPDB matches it with
// the ASCII-safe regexp `\x{2063}` (see rpc-yagpdb/infractions_sticky) — neither
// codebase keeps a literal invisible character in source. Only first-sighting
// duplicate-server pings carry it; dead-link pings deliberately omit it, so they
// notify the channel WITHOUT ever raising the member's infraction count.
const INFRACTION_MARKER = String.fromCodePoint(0x2063, 0x2063, 0x2063);

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

// Delete a dead-link post from its source channel. Returns true when the post
// is gone (including "already deleted"), false on a real failure so the caller
// keeps the grace flag and retries next sweep. Needs Manage Messages.
async function deletePost(client, row) {
  try {
    const channel = await client.channels.fetch(row.channel_id);
    if (!channel?.isTextBased()) return false;
    await channel.messages.delete(row.id);
    return true;
  } catch (err) {
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

// Run one offense type through the warn→grace→delete pipeline. `entries` is a
// list of { row, warn, removal } (pre-built message strings); `reason` keys the
// persisted grace clock so different offenses track independently. Posts past
// the grace window and still in violation are deleted; new offenses are warned
// once. Returns { warned, deleted }. Shared by dead-link and duplicate-server
// enforcement so both behave identically.
async function enforce(
  client,
  channel,
  entries,
  { reason, autoDelete, graceMs, counts = false, preserveIds = [] }
) {
  const ids = entries.map((e) => e.row.id);
  const flags = await db.getFlaggedPosts(ids, reason);
  const now = Date.now();
  let warned = 0;
  let deleted = 0;
  for (const { row, warn, removal } of entries) {
    const flaggedAt = flags.get(row.id);
    const expired = flaggedAt && now - flaggedAt.getTime() >= graceMs;

    // Past the grace window and still in violation → remove the post.
    if (autoDelete && expired) {
      const ok = await deletePost(client, row);
      if (ok) {
        deleted++;
        await db.clearFlaggedPosts([row.id], reason);
        await channel.send({ content: removal, allowedMentions: { parse: [] } });
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
      // Countable offenses (duplicates) carry the invisible marker on the FIRST
      // ping only, so YAGPDB logs exactly one infraction per offense. Dead-link
      // pings (counts=false) never carry it, so they notify without ever
      // incrementing the count.
      const content = counts && firstSighting ? warn + INFRACTION_MARKER : warn;
      await channel.send({ content, allowedMentions: { parse: ['users'] } });
      warned++;
    } catch (err) {
      console.error(`  ! notify failed for post ${row.id}: ${err.message}`);
    }
    await sleep(DELAY_MS);
  }
  // Un-flag posts no longer in violation (fixed/removed) so a re-offense starts
  // a fresh clock; an empty id set clears every stamp of this reason.
  await db.clearResolvedFlaggedPosts([...new Set([...ids, ...preserveIds])], reason);
  return { warned, deleted };
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

  // guild_id is no longer stored per message (single-server bot); take it from
  // the one guild we're in to build jump links.
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

  // Outage guard: during a Discord outage invite lookups fail across the
  // board — including good links coming back "Unknown Invite" (seen in the
  // July 2026 outage). When three quarters or more of the lookups fail (dead
  // and unverified both count, since an outage produces both), assume Discord
  // is broken rather than the links: the report still prints below, but no
  // notifications are posted.
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
      const jump = (row) => `https://discord.com/channels/${guildId}/${row.channel_id}/${row.id}`;
      const mention = (row, fallback) =>
        row.author_id ? `<@${row.author_id}>` : (row.author_tag ?? fallback);
      // Removal notices name the member without an @mention, so a deletion never
      // pings/highlights them — the earlier warning is the only member ping.
      const named = (row, fallback) => row.author_tag ?? fallback;
      const deadline = autoDelete
        ? `within ${GRACE_HOURS} hours or it will be removed`
        : 'as soon as you can';

      // --- Dead links: one entry per post with a dead invite ---
      const deadPosts = new Map(); // post id -> { row, count }
      for (const [code, posts] of postsByCode) {
        if (status.get(code) !== 'dead') continue;
        for (const row of posts) {
          const entry = deadPosts.get(row.id) ?? { row, count: 0 };
          entry.count++;
          deadPosts.set(row.id, entry);
        }
      }
      const deadEntries = [...deadPosts.values()].map(({ row, count }) => {
        const where = `<#${row.channel_id}>`;
        const what =
          count === 1
            ? `your link in ${where} has expired. Please update it with a valid link`
            : `${count} of your links in ${where} have expired. Please update them with valid links`;
        return {
          row,
          warn:
            `Hi ${mention(row, 'there')}, it looks like ${what} ${deadline}. ` +
            `For your convenience, [here is a link to your post](${jump(row)}). Thank you!`,
          removal:
            `🗑️ Removed ${named(row, 'A member')}'s post in ${where} — the dead invite ` +
            `link wasn't fixed within ${GRACE_HOURS} hours.`,
        };
      });

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
              `<#${keeper.channel_id}> can stay. [Here is a link to this post](${jump(row)}). Thank you!`,
            removal:
              `🗑️ Removed ${named(row, 'A member')}'s post in <#${row.channel_id}> — the same ` +
              `server was advertised in more than one channel (only one is allowed).`,
          });
        }
      }

      // Dead links notify only (no `counts`) — they must never raise a member's
      // infraction count. Duplicate-server offenses do count (marker on first flag).
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
        counts: true,
        preserveIds: unverifiedIds,
      });
      console.log(
        `Enforcement (grace ${GRACE_HOURS}h${autoDelete ? '' : ', deletion off'}): ` +
          `dead links ${dead.warned} warned / ${dead.deleted} removed; ` +
          `duplicate servers ${dup.warned} warned / ${dup.deleted} removed.`
      );
    }
  }
}

// --- Daily in-process scheduler (for hosts with no cron, e.g. Wispbyte) ---
// Fires a sweep once a day, at TARGET_HOUR UTC, reusing the live bot's client.
// A wall-clock target (not a 24h-from-boot interval) plus an in-memory
// "already ran today" guard keeps it to one run per calendar day even if the
// bot restarts — important because a notify run pings authors, so we must not
// re-run it several times a day. Set LINK_CHECK_HOUR to change the hour.
const TARGET_HOUR = Math.min(23, Math.max(0, Number(process.env.LINK_CHECK_HOUR) || 4));
const POLL_MS = 30 * 60 * 1000; // check the clock twice an hour
let lastRunDate = null; // 'YYYY-MM-DD' of the last completed sweep
let running = false;

function scheduleLinkCheck(client) {
  if (!CONFIGURED) {
    console.log('[check-links] disabled (LINK_CHECK_CHANNELS unset).');
    return;
  }
  const tick = async () => {
    if (running) return;
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
  const notify = (process.env.LINK_CHECK_NOTIFY_CHANNEL_ID || '').trim();
  const enforcement =
    GRACE_HOURS > 0 && notify
      ? `warn then delete after ${GRACE_HOURS}h`
      : GRACE_HOURS > 0 && !notify
        ? 'report only (deletion needs LINK_CHECK_NOTIFY_CHANNEL_ID)'
        : notify
          ? 'warn only (LINK_CHECK_GRACE_HOURS=0)'
          : 'report only';
  console.log(
    `[check-links] armed — daily around ${String(TARGET_HOUR).padStart(2, '0')}:00 UTC ` +
      `(${configured.size} target(s); ${enforcement}).`
  );
}

module.exports = { runLinkCheck, scheduleLinkCheck, CONFIGURED };

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
