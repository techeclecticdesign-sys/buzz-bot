// Advert failsafe — enforces the RPC advert rules while YAGPDB is offline.
// Mirrors the YAGPDB consolidated advert commands (group / 1x1 / quick):
//   HARD (delete + DM): length, cooldown, duplicate-in-channel
//   ADVISORY (keep + one ping to #rule_infractions): headers / images / links /
//   banned words / cross-channel duplicate
// Scope note: this version does NOT replicate the infraction ledger or advert
// bans — those live only in YAGPDB's database and can't be shared.
//
// Cooldown/duplicate state is read from the logger-bot's own message archive,
// so it's already "warm" the moment an outage starts. Everything here is gated
// on YAGPDB being offline; while YAGPDB is up this module does nothing.
const { EmbedBuilder } = require('discord.js');
const db = require('./db');
const failsafe = require('./failsafe');
const cfg = require('./advertConfig');
const checks = require('./advertChecks');

const { SHARED, INTRO } = cfg;

// The advert failsafe deletes posts, so require YAGPDB to be offline for a
// sustained period before acting — this rides out a brief presence blip from a
// reconnecting YAGPDB. Tunable via ADVERT_MIN_OFFLINE_SECS (default 60s).
const ADVERT_MIN_OFFLINE_MS = (Number(process.env.ADVERT_MIN_OFFLINE_SECS) || 60) * 1000;

// Edit-time checks are NOT a failsafe: YAGPDB's free tier can't trigger custom
// commands on message edits at all, so this fills a permanent gap rather than an
// outage. It therefore runs whether or not YAGPDB is online. Toggle off with
// ADVERT_EDIT_CHECKS=false.
const EDIT_CHECKS_ENABLED = process.env.ADVERT_EDIT_CHECKS !== 'false';

// Infraction re-check (auto-approval) — logger-bot's port of YAGPDB's
// infraction_recheck. After we post an advisory, a poll loop re-tests the post
// on a schedule: the first time it comes back clean the :staffpending: flag is
// removed from the post and the #rule_infractions ping is marked :staffapproved:;
// a post still broken at the terminal stage is removed and its ping approved to
// close it out. Applies to whatever we flagged, so it covers BOTH the edit path
// and the offline failsafe. Toggle off with INFRACTION_RECHECK=false; keep the
// post (approve + close without deleting) at the terminal stage with
// INFRACTION_RECHECK_DELETE=false.
const RECHECK_ENABLED = process.env.INFRACTION_RECHECK !== 'false';
const RECHECK_DELETE = process.env.INFRACTION_RECHECK_DELETE !== 'false';
// Stage times, mirroring YAGPDB: first re-check 10m after the ping, then 45m,
// 90m, and 480m (~8h). Stored as the delay (minutes) FROM the previous stage —
// [0] is the initial arm, [1..] each escalate a still-dirty post; once past the
// last entry the post is at the terminal stage (removed / closed). Hardcoded on
// purpose: this drives a destructive auto-delete, so the timing is not something
// an env var should be able to compress.
const RECHECK_STAGE_DELAYS_MIN = [10, 35, 45, 390]; // → 10, 45, 90, 480 absolute
const RECHECK_POLL_MS = Math.max(30, Number(process.env.INFRACTION_RECHECK_POLL_SECS) || 60) * 1000;

function truncate(str, max) {
  if (!str) return str;
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

// IDs of posts this module is deleting right now. The messageDelete handler
// consumes these so a failsafe removal doesn't also spawn a generic "Message
// deleted" embed (which would redundantly show the bot as the deleter) — the
// "advert removed" embed below is the single log entry.
const suppressedDeletes = new Set();

// True (and forgets the id) if this delete came from the advert failsafe.
function consumeSuppressedDelete(id) {
  return suppressedDeletes.delete(id);
}

// Per-type advisory wordings (only 1x1 / quick use these).
const HEADER_NONE_MSG = {
  '1x1': "Headers aren't allowed in the one-on-one advert channels. You're welcome to use regular **bold** instead.",
  quick: "Headers aren't allowed in the quick search channels. You're welcome to use regular **bold** instead.",
};
const IMAGE_MSG = {
  '1x1': "Images and other media aren't allowed in the 1x1 advert channels. Please remove any attachments.",
  quick: "Images and other media aren't allowed in the quick search channels. Please remove any attachments.",
};
const GROUP_HEADER_MSG =
  'Group adverts may only have **one** line of header text (including extra lines from wrapping if the text ' +
  'is too long). Use regular **bold** for any additional lines.';
const LINK_MSG = "Links aren't allowed in the quick search channels. Please remove it from your ad.";

function humanizeMinutes(ms) {
  let mins = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(mins / 1440);
  mins -= d * 1440;
  const h = Math.floor(mins / 60);
  mins -= h * 60;
  const parts = [];
  if (d) parts.push(`${d} day${d !== 1 ? 's' : ''}`);
  if (h) parts.push(`${h} hour${h !== 1 ? 's' : ''}`);
  if (mins) parts.push(`${mins} minute${mins !== 1 ? 's' : ''}`);
  if (!parts.length) return 'less than a minute';
  if (parts.length === 1) return parts[0];
  return parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1];
}

const channelLink = (guildId, id) => `https://discord.com/channels/${guildId}/${id}`;
const advertRuleLink = (guildId) => `[#advert_rules](${channelLink(guildId, SHARED.advertRulesChannelId)})`;
const footer = (guildId) =>
  `For additional information about posting advertisements, please see our ${advertRuleLink(guildId)} ` +
  `channel. If you have any further questions please feel free to ask on <#${SHARED.askTheStaffChannelId}>.`;

// The shared "not posted" DM. `reason` fills the title; `whatToDo` the field.
function rejectEmbed(name, channelName, reason, whatToDo, content) {
  return new EmbedBuilder()
    .setColor(SHARED.embed.color)
    .setTitle(
      truncate(
        `Hello ${name}!\n\nYour recent post from #${channelName} was not posted because ${reason}. ` +
          'Here is the message that was not posted: ',
        256
      )
    )
    .setDescription(truncate(content || '*(no text content)*', 4096))
    .addFields({ name: '**What can you do about this?**', value: truncate(whatToDo, 1024) })
    .setAuthor({ name: SHARED.embed.authorName, iconURL: SHARED.embed.icon })
    .setThumbnail(SHARED.embed.icon);
}

function lengthDM(type, message, guildId) {
  if (type.lengthMode === 'words') {
    const lf = cfg.QUICK_LONGFORM_BY_NAME[message.channel?.name];
    const longForm = lf ? `[#${lf.name}](${channelLink(guildId, lf.id)})` : 'a long-form channel';
    return {
      reason: 'it exceeds the hundred word limit for the quick search channels',
      whatToDo:
        `**If you want to keep the current length of your post please move it to ${longForm}. ` +
        'Please note all advertisements on this channel must be kept to one non-Nitro length Discord post, ' +
        'but can include a link to a Google Doc with additional information.\n\n' +
        "If you want to keep your post in the current channel, you must shorten it to be at or under 100 words " +
        "and re-send your ad once it's within that word limit. You can check your eligibility in our " +
        "'Can I post' channel. Keep in mind a lot of information may be given using the Quick Reaction Tags.\n\n" +
        footer(guildId) +
        '**',
    };
  }
  return {
    reason: 'it exceeds the 2000 character limit for our long-form ad channels',
    whatToDo:
      '**Please adjust your post to be at or under the max length of a non-Nitro post, which is 2,000 characters. ' +
      'Please note all advertisements in our group channels must be kept to one Discord post, but can include a ' +
      'link to a Google Doc with additional information.\n\n' +
      'If you want to keep your post in the current channel, please shorten it to 2000 characters or less. ' +
      'Keep in mind a lot of information may be given using the Post a Plot Tags.\n\n' +
      footer(guildId) +
      '**',
  };
}

const cooldownDM = (guildId, remainingMs) => ({
  reason: 'you have posted an advertisement on this channel too recently',
  whatToDo:
    `**You are free to wait and post again in ${humanizeMinutes(remainingMs)}, once your post cooldown has ` +
    "expired. You can check your eligibility to repost in our 'Can I Post' channel.\n\n" +
    footer(guildId) +
    '**',
});

const duplicateDM = (guildId, channelId, oldMsgId) => ({
  reason: 'you already have an advertisement on this channel',
  whatToDo:
    `**You are free to delete your [old advert](${channelLink(guildId, channelId)}/${oldMsgId}). ` +
    'Once you have successfully posted a new advert your cooldown period will be restarted. You can check your ' +
    "eligibility to repost in our 'Can I Post' channel.\n\n" +
    footer(guildId) +
    '**',
});

function getChannel(message, id) {
  return message.guild.channels.cache.get(id) ?? message.client.channels.fetch(id).catch(() => null);
}

// Delete the post first, then DM the author — but only tell them (and log a
// removal) if the delete actually succeeded, so a missing-permission failure
// never leaves the post up while DMing "it wasn't posted". `noun` (advert /
// intro) only tweaks the staff-log wording; the member DM is fully driven by dm.
async function reject(message, sendLog, name, channelName, dm, tag, noun = 'advert') {
  const embed = rejectEmbed(name, channelName, dm.reason, dm.whatToDo, message.content ?? '');
  const content = message.content ?? '';
  // Mark before deleting so the messageDelete handler suppresses its own embed.
  suppressedDeletes.add(message.id);
  try {
    await message.delete();
  } catch (err) {
    suppressedDeletes.delete(message.id); // delete failed — nothing to suppress
    console.error(`[advert-failsafe] delete failed (Manage Messages?): ${err.message}`);
    if (sendLog) {
      await sendLog({
        content:
          `⚠️ Failsafe could **not** remove <@${message.author.id}>'s ${tag} ${noun} in ` +
          `<#${message.channelId}> (missing **Manage Messages**?). Post left in place; no DM sent.`,
        allowedMentions: { parse: [] },
      });
    }
    return;
  }
  // The suppressed messageDelete handler would normally do this: record the
  // removal in the archive so this rejected post never counts as the user's
  // standing advert (which would wrongly block their next legit post).
  try {
    await db.markDeleted(message.id);
  } catch (err) {
    console.error(`[advert-failsafe] markDeleted(${message.id}) failed: ${err.message}`);
  }
  try {
    await message.author.send({ embeds: [embed] });
  } catch {
    /* author has DMs closed — the post is already removed, nothing else to do */
  }
  // No general-log echo for a successful removal: infractions do not go to
  // general logs. (The missing-permissions warning above is kept — that's an
  // operational "the failsafe couldn't act" alert, not an infraction record.)
}

async function crossChannelDup(message, content) {
  const norm = checks.normalizeForDupe(content);
  if (norm.length < 15) return null;
  const rows = await db.getStandingAdvertsInChannels(message.author.id, cfg.ALL_ADVERT_CHANNELS, message.channelId);
  for (const r of rows) {
    if (checks.normalizeForDupe(r.content) === norm) return r.channel_id;
  }
  return null;
}

// Post the one combined advisory ping. `opts.title` / `opts.headline` set the
// staff-log wording so the create path (a genuine outage) and the edit path (runs
// whether or not YAGPDB is online) each read accurately.
async function postAdvisory(message, sendLog, issues, opts = {}) {
  const {
    title = 'Failsafe: advert flagged',
    headline = `YAGPDB is offline — flagged a kept post to <#${SHARED.infractionsChannelId}>.`,
    lengthNote = false,
    edited = false,
  } = opts;
  const body = issues.map((i) => `\n• ${i}`).join('');
  // The emoji/character-count note only makes sense next to a length advisory
  // (which only edits produce — a new post over the limit is deleted, not
  // pinged). Appending it to header/image/link advisories was just noise.
  const note = lengthNote
    ? '\n\nNote: we count character length the same way Discord does, so custom emoji can easily be ' +
      'more than 30 characters apiece even though they show as one.'
    : '';
  // On the edit path, name it an "edited post" so the member (and staff) can tell
  // this fired on a later edit, not the original post YAGPDB already flagged.
  const subject = edited ? 'edited post' : 'post';
  const text = truncate(
    `Hey <@${message.author.id}> ! A few things to fix in your ${subject} in <#${message.channelId}>:${body}${note}`,
    2000
  );
  const channel = await getChannel(message, SHARED.infractionsChannelId);
  let sent = null;
  if (channel) {
    sent = await channel.send({ content: text, allowedMentions: { users: [message.author.id] } });
  }
  if (SHARED.staffPendingEmoji) {
    try {
      await message.react(SHARED.staffPendingEmoji);
    } catch {
      /* emoji unavailable or missing Add Reactions — non-fatal */
    }
  }
  // No general-log echo: the advisory already lives in #rule_infractions and the
  // :staffpending: flag sits on the post. Infractions do not go to general logs.
  // The sent message is returned so the edit path can "bump" it on a re-edit.
  return sent;
}

// Called after an advisory is posted (edit path or offline failsafe). Two jobs,
// both keyed to the offending post so there's exactly one live advisory per post:
//   • BUMP — if a prior advisory is remembered for this post, delete it now that a
//     fresh one exists, so #rule_infractions shows one current ping, not a stack.
//   • ARM the re-check — record the new advisory id + the post's channel and set
//     the first re-check ~10m out, restarting the clock (a fresh edit gets a fresh
//     window). The poll loop takes it from there.
// `posted` is the just-sent advisory (null when nothing tripped → no-op).
async function recordAdvisory(message, posted) {
  if (!posted) return;
  try {
    const prev = await db.getAdvertInfraction(message.id);
    if (prev?.advisory_id && prev.advisory_id !== posted.id) {
      const channel = await getChannel(message, SHARED.infractionsChannelId);
      const old = channel ? await channel.messages.fetch(prev.advisory_id).catch(() => null) : null;
      if (old) await old.delete().catch(() => {});
    }
    const nextCheckAt = RECHECK_ENABLED
      ? new Date(Date.now() + RECHECK_STAGE_DELAYS_MIN[0] * 60000)
      : null;
    await db.setAdvertInfraction(message.id, posted.id, message.channelId, nextCheckAt);
  } catch (err) {
    console.error(`[advert-recheck] record failed for ${message.id}: ${err.message}`);
  }
}

// ---- Shared checks, reused by both the create failsafe and the edit trigger ----

// Pure predicate: is the content over this channel's length limit?
function isOverLength(type, content) {
  return type.lengthMode === 'words'
    ? checks.wordCount(content) >= type.maxWords
    : checks.runeLength(content) > type.maxChars;
}

// LENGTH as a HARD rule (new posts only): reject the post (delete + DM) if it's
// over the channel's limit and return true; false if it's within limit.
async function enforceLength(message, sendLog, type, name, channelName, content, guildId) {
  if (!isOverLength(type, content)) return false;
  await reject(message, sendLog, name, channelName, lengthDM(type, message, guildId), 'length');
  return true;
}

// LENGTH as an ADVISORY (edits only): rather than delete a post someone is in the
// middle of editing, keep it and warn — same bullet tone as the other advisories,
// with the quick channels pointing at their long-form counterpart the way the
// cross-channel-dup advisory links a channel.
function lengthAdvisory(type, message) {
  if (type.lengthMode === 'words') {
    const lf = cfg.QUICK_LONGFORM_BY_NAME[message.channel?.name];
    const moveTo = lf ? ` — or move it to <#${lf.id}>` : '';
    return (
      'After your edit, this post is over the 100 word limit for the quick search channels. ' +
      `Please shorten it to 100 words or fewer${moveTo}, or your ad will be removed.`
    );
  }
  return (
    'After your edit, this post is over the 2,000 character limit for this channel. ' +
    'Please shorten it to 2,000 characters or less, or your ad will be removed.'
  );
}

// Collect every ADVISORY hit (post is kept) — headers / images / links (per
// channel type), banned words, cross-channel duplicate — as human-readable
// bullet strings. NOT length: that's the create-path hard rule / the edit-path
// lead. Shared by the advisory ping (runAdvisories) and the re-check's dirtiness
// test (isPostDirty), so "what counts as a violation" is defined once.
async function collectIssues(message, type, content) {
  const issues = [];
  if (type.rules.headers === 'group') {
    if (checks.groupHeaderIssue(content)) issues.push(GROUP_HEADER_MSG);
  } else if (type.rules.headers === 'none') {
    if (checks.hasAnyHeader(content)) issues.push(HEADER_NONE_MSG[type.name]);
  }
  if (type.rules.images && message.attachments.size > 0) issues.push(IMAGE_MSG[type.name]);
  if (type.rules.links && checks.linkPresent(content)) issues.push(LINK_MSG);

  const bh = checks.bannedHits(content, SHARED.banned);
  if (bh.length) issues.push(`It contains wording that isn't allowed here: ${bh.join(' ')}`);

  const dupChannelId = await crossChannelDup(message, content);
  if (dupChannelId) {
    issues.push(
      `It looks identical to your ad in <#${dupChannelId}>. Cross-channel adverts must be distinctly different ` +
        'from each other and searching for different things. Please choose a channel for your advert.'
    );
  }
  return issues;
}

// Collect + post the one combined advisory. `leadIssues` are prepended (the edit
// path uses this for the over-length warning) so everything lands in a single
// ping. Returns the posted advisory message (so callers can bump / arm the
// re-check), or null when nothing tripped.
async function runAdvisories(message, sendLog, type, content, leadIssues = [], advisoryOpts = {}) {
  const issues = [...leadIssues, ...(await collectIssues(message, type, content))];
  if (!issues.length) return null;
  return postAdvisory(message, sendLog, issues, advisoryOpts);
}

// Is this post still in violation? The re-check's "dirty" test — same ruleset the
// advisory uses (length + every collectIssues hit), so :staffpending: only clears
// once the post passes the FULL set, not just the rule that first flagged it.
// Resolves the channel type itself; intros (not an advert type) fall back to
// their own 800-char rule. An unknown channel is treated as clean (nothing to do).
async function isPostDirty(message) {
  const content = message.content ?? '';
  const type = cfg.typeForChannel(message.channelId);
  if (type) {
    if (isOverLength(type, content)) return true;
    return (await collectIssues(message, type, content)).length > 0;
  }
  if (cfg.introConfigured && message.channelId === INTRO.channelId) {
    return checks.runeLength(content) > INTRO.maxChars;
  }
  return false;
}

// Entry point, called from messageCreate for every message. Cheap early-outs
// keep it near-free on non-advert traffic and whenever YAGPDB is online.
async function handleAdvert(message, sendLog) {
  if (!failsafe.ENABLED || !cfg.configured) return;
  if (!message.guild || message.author.bot || message.system) return; // skip bots + join/pin/boost notices
  const type = cfg.typeForChannel(message.channelId);
  if (!type) return; // not a configured advert channel
  if (failsafe.isYagpdbOnline(message.guild)) return; // YAGPDB up → stay dormant
  // Sustained-outage guard: don't delete posts over a momentary YAGPDB blip.
  if (failsafe.offlineForMs(message.guild) < ADVERT_MIN_OFFLINE_MS) return;

  const guildId = message.guildId;
  const name = message.member?.nickname ?? message.author.username;
  const channelName = message.channel?.name ?? 'this channel';
  const content = message.content ?? '';

  // ---- 1. LENGTH ----
  if (await enforceLength(message, sendLog, type, name, channelName, content, guildId)) return;

  // ---- 2 & 3. COOLDOWN + DUPLICATE-IN-CHANNEL ----
  const lockoutMs = type.lockoutHours * 3600000;
  const now = Date.now();
  const standing = await db.getStandingAdvert(message.channelId, message.author.id, message.id);
  if (standing) {
    const age = now - new Date(standing.created_at).getTime();
    if (age < lockoutMs) {
      await reject(message, sendLog, name, channelName, cooldownDM(guildId, lockoutMs - age), 'cooldown');
    } else {
      await reject(message, sendLog, name, channelName, duplicateDM(guildId, message.channelId, standing.id), 'duplicate');
    }
    return;
  }
  // No standing post — grace window: allow a repost if the last post here was
  // deleted under graceSecs ago; otherwise it's still a cooldown block.
  const lastDeleted = await db.getLastDeletedAdvert(message.channelId, message.author.id, message.id);
  if (lastDeleted) {
    const age = now - new Date(lastDeleted.created_at).getTime();
    if (age < lockoutMs && age > SHARED.graceSecs * 1000) {
      await reject(message, sendLog, name, channelName, cooldownDM(guildId, lockoutMs - age), 'cooldown');
      return;
    }
  }

  // ---- POST IS KEPT — advisory checks (collect into one ping) ----
  const posted = await runAdvisories(message, sendLog, type, content);
  await recordAdvisory(message, posted); // arm the auto-approval re-check
}

// Entry point for message *edits*, called from messageUpdate. YAGPDB's free tier
// can't run custom commands on edits, so this isn't gated on a YAGPDB outage the
// way handleAdvert is — it always enforces, closing a hole where a member could
// post a clean ad and then edit in something that breaks the rules.
//
// Edits are NON-DESTRUCTIVE: unlike a new post, an over-length edit isn't
// deleted — deleting a post out from under someone mid-edit is too harsh. Length
// instead becomes an advisory that rides along in the same combined ping, warning
// the author to fix it or the ad will be removed (by staff, on review). Cooldown
// and duplicate-in-channel are skipped entirely: they're about how often / how
// many times someone *posts*, which editing an existing post isn't.
async function handleAdvertEdit(message, sendLog) {
  if (!EDIT_CHECKS_ENABLED || !cfg.configured) return;
  if (!message.guild || message.author.bot || message.system) return;
  const type = cfg.typeForChannel(message.channelId);
  if (!type) return; // not a configured advert channel

  // Re-run every content rule on the edited post: YAGPDB (free tier) can't run on
  // edits at all, so this is the only thing enforcing them after an edit. Over-
  // length rides along as an advisory lead (non-destructive — warn, don't delete
  // a post someone is mid-edit on). recordAdvisory below keeps this to one live
  // advisory per post no matter how many times they edit, and arms the re-check.
  const content = message.content ?? '';
  const lead = isOverLength(type, content) ? [lengthAdvisory(type, message)] : [];
  const posted = await runAdvisories(message, sendLog, type, content, lead, {
    edited: true,
    lengthNote: lead.length > 0,
    title: 'Advert edit flagged',
    headline: `Flagged an edited advert to <#${SHARED.infractionsChannelId}>.`,
  });
  await recordAdvisory(message, posted);
}

// ---- Member introductions ----------------------------------------------------
// A direct port of YAGPDB's "Member Intros" custom command (NOT the advert
// rules): an 800-character limit and one intro per member, both hard (delete +
// DM), reusing the same reject/DM plumbing. Dormant unless introChannelId is set.

// The "[member intro rules]" link the DM points at — the pinned rules post inside
// the intros channel, exactly as the YAGPDB command builds it.
const introRuleLink = (guildId) =>
  `[member intro rules](${channelLink(guildId, INTRO.channelId)}/${INTRO.rulesMessageId})`;
const introContact =
  'Please feel free to reach out to a member of the RPC moderation team if you have any further questions.';

const introLengthDM = (guildId) => ({
  reason: 'it exceeds the 800-character limit for the member intros channel',
  whatToDo:
    '**Please shorten your post to fit within the 800-character limit.\n\n' +
    `For additional information about posting member intros, please see our ${introRuleLink(guildId)}. ` +
    introContact +
    '**',
});

const introDuplicateDM = (guildId, oldMsgId) => ({
  reason: 'you already have a member intro in this channel',
  whatToDo:
    '**If you are posting a new member intro, go ahead and delete your ' +
    `[old intro](${channelLink(guildId, INTRO.channelId)}/${oldMsgId}).\n\n` +
    `For additional information about posting member intros, please see our ${introRuleLink(guildId)}. ` +
    introContact +
    '**',
});

// Edit-only advisory (non-destructive), mirroring the advert edit exception: an
// over-length *edit* is warned rather than deleted.
const introLengthAdvisory = () =>
  'After your edit, this intro is over the 800 character limit for the member intros channel. ' +
  'Please shorten it to 800 characters or less, or your intro will be removed.';

// New-post enforcement while YAGPDB is offline — mirrors handleAdvert's gating.
async function handleIntro(message, sendLog) {
  if (!failsafe.ENABLED || !cfg.introConfigured) return;
  if (!message.guild || message.author.bot || message.system) return;
  if (message.channelId !== INTRO.channelId) return;
  if (failsafe.isYagpdbOnline(message.guild)) return; // YAGPDB up → stay dormant
  if (failsafe.offlineForMs(message.guild) < ADVERT_MIN_OFFLINE_MS) return; // sustained-outage guard

  const guildId = message.guildId;
  const name = message.member?.nickname ?? message.author.username;
  const channelName = message.channel?.name ?? 'this channel';
  const content = message.content ?? '';

  // ---- LENGTH (hard, > 800 chars) ----
  if (checks.runeLength(content) > INTRO.maxChars) {
    await reject(message, sendLog, name, channelName, introLengthDM(guildId), 'length', 'intro');
    return;
  }
  // ---- ONE INTRO PER MEMBER (hard) ----
  const standing = await db.getStandingAdvert(message.channelId, message.author.id, message.id);
  if (standing) {
    await reject(message, sendLog, name, channelName, introDuplicateDM(guildId, standing.id), 'duplicate', 'intro');
  }
}

// Edit enforcement — always on (YAGPDB can't run on edits), non-destructive.
// Over-length becomes an advisory; the one-per-member rule is skipped (editing an
// existing intro isn't a second intro).
async function handleIntroEdit(message, sendLog) {
  if (!EDIT_CHECKS_ENABLED || !cfg.introConfigured) return;
  if (!message.guild || message.author.bot || message.system) return;
  if (message.channelId !== INTRO.channelId) return;

  const content = message.content ?? '';
  if (checks.runeLength(content) > INTRO.maxChars) {
    const posted = await postAdvisory(message, sendLog, [introLengthAdvisory()], {
      edited: true,
      lengthNote: true,
      title: 'Intro edit flagged',
      headline: `Flagged an edited intro to <#${SHARED.infractionsChannelId}>.`,
    });
    await recordAdvisory(message, posted);
  }
}

// ---- Infraction re-check (auto-approval) sweep ------------------------------
// Port of YAGPDB's infraction_recheck. A poll loop pulls posts whose re-check is
// due (recordAdvisory arms the first one ~10m after an advisory) and re-tests
// each against the FULL ruleset. The row keyed the post to its advisory ping, so
// this closes the loop for whatever we flagged — edit path and offline failsafe
// alike. See RECHECK_* config near the top of this file.

const fetchChannelById = (client, id) =>
  client.channels.cache.get(id) ?? client.channels.fetch(id).catch(() => null);

// Cache key discord.js uses for a reaction: a custom emoji's id, else the unicode
// glyph. Accepts "name:id", "<:name:id>", "<a:name:id>", a bare id, or unicode.
function reactionKey(spec) {
  const m = /:(\d{5,})>?$/.exec(spec || '');
  return m ? m[1] : spec; // custom emoji → its id; bare id / unicode → as-is
}

// Remove ALL of one emoji's reactions from a post — mirrors YAGPDB's
// deleteAllMessageReactions (needs Manage Messages). Non-fatal on failure.
async function clearReaction(message, emojiSpec) {
  if (!emojiSpec) return;
  const reaction = message.reactions.cache.get(reactionKey(emojiSpec));
  if (reaction) await reaction.remove().catch(() => {});
}

// Mark the #rule_infractions ping :staffapproved: — the auto-approval itself.
async function approvePing(client, advisoryId) {
  if (!SHARED.staffApprovedEmoji || !advisoryId) return;
  const channel = await fetchChannelById(client, SHARED.infractionsChannelId);
  if (!channel?.messages) return;
  const ping = await channel.messages.fetch(advisoryId).catch(() => null);
  if (ping) await ping.react(SHARED.staffApprovedEmoji).catch(() => {});
}

// Terminal-stage removal of a still-broken post. Suppresses the generic
// "message deleted" log (this is an enforcement action, like reject) and records
// the deletion in the archive. Warns staff on a permissions failure.
async function deleteStalePost(post, sendLog) {
  suppressedDeletes.add(post.id);
  try {
    await post.delete();
    await db.markDeleted(post.id).catch(() => {});
    return true;
  } catch (err) {
    suppressedDeletes.delete(post.id);
    console.error(`[advert-recheck] terminal delete failed for ${post.id}: ${err.message}`);
    if (sendLog) {
      await sendLog({
        content:
          `⚠️ Infraction re-check could **not** remove <@${post.author?.id}>'s still-unfixed post in ` +
          `<#${post.channelId}> (missing **Manage Messages**?). Left in place.`,
        allowedMentions: { parse: [] },
      }).catch(() => {});
    }
    return false;
  }
}

// One due row. clean → clear the flag + approve the ping + drop the row; gone →
// drop the row; dirty → schedule the next stage, or at the terminal stage remove
// the post (unless RECHECK_DELETE=false), approve the ping to close it out, and
// drop the row. Transient fetch failures reschedule so the row is never lost.
async function processRecheck(client, row, sendLog) {
  const channel = await fetchChannelById(client, row.channel_id);
  let post = null;
  if (channel?.messages) {
    post = await channel.messages.fetch(row.advert_id).catch((err) => (err.code === 10008 ? 'gone' : null));
  }
  if (post === 'gone') {
    await db.clearAdvertInfraction(row.advert_id, row.advisory_id); // post removed — its flag died with it
    return;
  }
  if (!post) {
    // Couldn't read the post this time (channel/permission/network) — retry at the
    // next cadence rather than lose or prematurely close the row.
    const retryMin = RECHECK_STAGE_DELAYS_MIN[Math.min(row.stage, RECHECK_STAGE_DELAYS_MIN.length - 1)];
    await db.advanceRecheck(row.advert_id, row.stage, new Date(Date.now() + retryMin * 60000), row.advisory_id);
    return;
  }

  if (!(await isPostDirty(post))) {
    await clearReaction(post, SHARED.staffPendingEmoji);
    await approvePing(client, row.advisory_id);
    await db.clearAdvertInfraction(row.advert_id, row.advisory_id);
    return;
  }

  // Still in violation. Past the last scheduled stage → terminal: remove + close.
  if (row.stage >= RECHECK_STAGE_DELAYS_MIN.length) {
    if (RECHECK_DELETE) await deleteStalePost(post, sendLog);
    await approvePing(client, row.advisory_id); // close the ping out either way
    await db.clearAdvertInfraction(row.advert_id, row.advisory_id);
    return;
  }
  // Not yet terminal → schedule the next stage.
  const delayMin = RECHECK_STAGE_DELAYS_MIN[row.stage];
  await db.advanceRecheck(row.advert_id, row.stage + 1, new Date(Date.now() + delayMin * 60000), row.advisory_id);
}

// Process every re-check that's currently due. Errors on one row never abort the
// rest (or the poll loop).
async function runDueRechecks(client, sendLog) {
  if (!RECHECK_ENABLED) return;
  let rows;
  try {
    rows = await db.getDueRechecks(new Date());
  } catch (err) {
    console.error('[advert-recheck] due query failed:', err.message);
    return;
  }
  for (const row of rows) {
    try {
      await processRecheck(client, row, sendLog);
    } catch (err) {
      console.error(`[advert-recheck] stage ${row.stage} failed for ${row.advert_id}: ${err.message}`);
    }
  }
}

// In-process poll loop (hosts here run `npm start` with no cron), mirroring
// checkLinks.scheduleLinkCheck. A re-entrancy guard keeps a slow sweep from
// overlapping itself.
function scheduleRechecks(client, sendLog) {
  if (!RECHECK_ENABLED) {
    console.log('[advert-recheck] disabled (INFRACTION_RECHECK=false).');
    return;
  }
  if (!cfg.configured && !cfg.introConfigured) {
    console.log('[advert-recheck] inactive — no advert/intro channels configured.');
    return;
  }
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await runDueRechecks(client, sendLog);
    } finally {
      running = false;
    }
  };
  setInterval(tick, RECHECK_POLL_MS).unref?.();
  console.log(
    `[advert-recheck] armed — auto-approval re-checks polled every ${RECHECK_POLL_MS / 1000}s ` +
      `(stages ~10/45/90/480m; terminal ${RECHECK_DELETE ? 'delete' : 'close-only'}).`
  );
}

module.exports = {
  handleAdvert,
  handleAdvertEdit,
  consumeSuppressedDelete,
  handleIntro,
  handleIntroEdit,
  scheduleRechecks,
  runDueRechecks,
  configured: cfg.configured,
  introConfigured: cfg.introConfigured,
  recheckActive: RECHECK_ENABLED && (cfg.configured || cfg.introConfigured),
  // True when edit-time enforcement is both switched on and has channels to act
  // on — lets index.js keep the messageUpdate fast-path when nothing needs it.
  editChecksActive: EDIT_CHECKS_ENABLED && cfg.configured,
  introEditActive: EDIT_CHECKS_ENABLED && cfg.introConfigured,
  channelCount: cfg.ALL_ADVERT_CHANNELS.length,
};
