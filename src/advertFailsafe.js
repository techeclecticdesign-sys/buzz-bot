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

const { SHARED } = cfg;

// The advert failsafe deletes posts, so require YAGPDB to be offline for a
// sustained period before acting — this rides out a brief presence blip from a
// reconnecting YAGPDB. Tunable via ADVERT_MIN_OFFLINE_SECS (default 60s).
const ADVERT_MIN_OFFLINE_MS = (Number(process.env.ADVERT_MIN_OFFLINE_SECS) || 60) * 1000;

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
  'Group adverts may only have **one** line of header text. Use regular **bold** for any additional lines.';
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
// never leaves the post up while DMing "it wasn't posted".
async function reject(message, sendLog, name, channelName, dm, tag) {
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
          `⚠️ Failsafe could **not** remove <@${message.author.id}>'s ${tag} advert in ` +
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
  if (sendLog) {
    await sendLog({
      embeds: [
        new EmbedBuilder()
          .setColor(0xe67e22)
          .setTitle('⚠️ Failsafe: advert removed')
          .setDescription(
            `YAGPDB is offline — removed a post that failed the **${tag}** check.\n\n` +
              `**Member:** <@${message.author.id}> (\`${message.author.username}\`)\n` +
              `**Channel:** <#${message.channelId}>`
          )
          .addFields({ name: 'Post', value: truncate(content || '*(no text)*', 1024) })
          .setTimestamp(),
      ],
    });
  }
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

async function postAdvisory(message, sendLog, issues) {
  const body = issues.map((i) => `\n• ${i}`).join('');
  const text = truncate(
    `Hey <@${message.author.id}> ! A few things to fix in your post in <#${message.channelId}>:${body}\n\n` +
      'Please edit your post. Thanks!',
    2000
  );
  const channel = await getChannel(message, SHARED.infractionsChannelId);
  if (channel) {
    await channel.send({ content: text, allowedMentions: { users: [message.author.id] } });
  }
  if (SHARED.staffPendingEmoji) {
    try {
      await message.react(SHARED.staffPendingEmoji);
    } catch {
      /* emoji unavailable or missing Add Reactions — non-fatal */
    }
  }
  if (sendLog) {
    await sendLog({
      embeds: [
        new EmbedBuilder()
          .setColor(0xf1c40f)
          .setTitle('Failsafe: advert flagged')
          .setDescription(
            `YAGPDB is offline — flagged a kept post to <#${SHARED.infractionsChannelId}>.\n\n` +
              `**Member:** <@${message.author.id}> (\`${message.author.username}\`)\n` +
              `**Channel:** <#${message.channelId}>\n` +
              `**Issues:** ${issues.length}`
          )
          .setTimestamp(),
      ],
    });
  }
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
  const overLength =
    type.lengthMode === 'words'
      ? checks.wordCount(content) >= type.maxWords
      : checks.runeLength(content) > type.maxChars;
  if (overLength) {
    await reject(message, sendLog, name, channelName, lengthDM(type, message, guildId), 'length');
    return;
  }

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

  if (issues.length) await postAdvisory(message, sendLog, issues);
}

module.exports = {
  handleAdvert,
  consumeSuppressedDelete,
  configured: cfg.configured,
  channelCount: cfg.ALL_ADVERT_CHANNELS.length,
};
