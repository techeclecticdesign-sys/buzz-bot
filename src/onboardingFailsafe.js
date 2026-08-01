// Onboarding failsafe — takes over YAGPDB's age-verification + rules-reaction
// role flow while YAGPDB ("Jarvis") is offline. Like the rest of the failsafe,
// every action here no-ops while any YAGPDB instance is online.
//
// The RPC onboarding gate, as run by YAGPDB normally:
//   join            -> Age Please        (handled by failsafe.handleMemberJoin)
//   age in #age_..  -> Rules Please       (this module: handleAgeMessage)
//   react to rules  -> Newbie             (this module: handleRulesReaction)
//
// Age handling reproduces the YAGPDB custom command as closely as possible,
// including the two embeds (invalid entry / over-max) and the under-min kick.
const { EmbedBuilder } = require('discord.js');
const failsafe = require('./failsafe');

// The channel where members type their age. No default: leaving it unset keeps
// the whole onboarding failsafe dormant (mirrors the advert failsafe being
// inactive when no channels are configured). Right-click the age-verification
// channel -> Copy Channel ID.
const AGE_VERIFY_CHANNEL_ID = (process.env.AGE_VERIFY_CHANNEL_ID || '').trim();

// Roles in the onboarding gate. Defaults are RPC's live IDs; override per server.
const AGE_PLEASE_ROLE_ID = failsafe.AGE_PLEASE_ROLE_ID; // 735544386678554738
const RULES_PLEASE_ROLE_ID = (process.env.RULES_PLEASE_ROLE_ID || '634585076524646401').trim();
const NEWBIE_ROLE_ID = (process.env.NEWBIE_ROLE_ID || '456657052136243210').trim();

// The server-rules message and the reaction that agrees to the rules.
const RULES_MESSAGE_ID = (process.env.RULES_MESSAGE_ID || '1385675552601411605').trim();
const RULES_EMOJI_ID = (process.env.RULES_EMOJI_ID || '658510846779195423').trim();
const RULES_EMOJI_NAME = (process.env.RULES_EMOJI_NAME || 'rpc').trim();

// Members who enter an age below MIN_AGE are kicked (matches YAGPDB); MIN_AGE is
// the only knob for that — set it to the server's minimum. MAX_AGE just bounds
// the "two-digit age" warning embed.
const MIN_AGE = Number(process.env.MIN_AGE) || 15;
const MAX_AGE = Number(process.env.MAX_AGE) || 75;

// Kicking an under-age member is destructive, so require YAGPDB to have been
// offline for a sustained period first (rides out a brief reconnect blip). Reuses
// the advert failsafe's threshold so there is one "how long is a real outage?"
// knob. The non-destructive role grants act immediately, like the join task.
const MIN_OFFLINE_MS = (Number(process.env.ADVERT_MIN_OFFLINE_SECS) || 60) * 1000;

// Both handlers are dormant until an age-verification channel is configured.
const configured = !!AGE_VERIFY_CHANNEL_ID;

// Muted RPC purple used by the YAGPDB embeds (decimal 9124978 == 0x8b3c72).
const EMBED_COLOR = 9124978;
const AVATAR = 'https://i.ibb.co/mt5sNFb/Main.png';
const AUTHOR = { name: 'Roleplay Central Database', iconURL: AVATAR };

const emojiTag = `<:${RULES_EMOJI_NAME}:${RULES_EMOJI_ID}>`;

// Mirror YAGPDB's `toInt .Message.Content` (strconv.ParseInt, base 10): a whole
// string that is an optionally-signed integer, else 0. Non-numeric / empty /
// spaced input all read as 0 there, which triggers the "invalid entry" embed.
function toIntYag(content) {
  return /^[+-]?\d+$/.test(content) ? parseInt(content, 10) : 0;
}

function displayName(member) {
  return member.nickname || member.user.username;
}

// The "invalid entry" embed YAGPDB sends when the message isn't a number.
// `entered` is the raw message content, echoed back in the "What you entered" field.
function invalidEmbed(member, channel, entered) {
  const guildId = member.guild.id;
  const instructions =
    '_ _\n' +
    `Please go to [#${channel.name}](https://discordapp.com/channels/${guildId}/${channel.id}) ` +
    'and type in your current age in numerical form. You will not be able to read message history ' +
    'to ensure the privacy of our members. \n' +
    '*Example:* 22\n\n' +
    'Once you have input your age you will gain access to our server rules. Please read and react ' +
    'to show you agree with the rules to gain access to the rest of the server. \n\n' +
    '**Disclaimer: \nIf you are found to be lying about your age you will be banned from the server ' +
    'for the safety of our members.**';

  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setAuthor(AUTHOR)
    .setThumbnail(AVATAR)
    .setTitle(`Hello ${displayName(member)}!`)
    .setDescription(
      'While we feel roleplaying is an activity for all ages, RPC is a 15+ server. As a result, ' +
      'we would ask you to verify your age to gain access to our site.'
    )
    .addFields(
      { name: `${emojiTag} Instructions ${emojiTag}`, value: instructions, inline: false },
      { name: 'What you entered', value: entered, inline: false }
    );
}

// The "over-max age" warning embed.
function overMaxEmbed(member, content) {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setAuthor(AUTHOR)
    .setThumbnail(AVATAR)
    .setTitle(`Hello ${displayName(member)}!`)
    .setDescription(
      "Please input a two-digit age under 75. Do not input any special characters (including '', !, -, and #) " +
      'nor a date of birth. Thank you!'
    )
    .addFields({ name: 'What you Entered:', value: `${content}.`, inline: false });
}

// Handle a message in the age-verification channel while YAGPDB is offline.
// `sendLog` is index.js's log-channel sender (passed to avoid a circular require).
async function handleAgeMessage(message, sendLog) {
  if (!failsafe.ENABLED || !configured) return;
  if (message.channelId !== AGE_VERIFY_CHANNEL_ID) return;
  if (!message.guild || message.author.bot) return;
  if (failsafe.isYagpdbOnline(message.guild)) return; // YAGPDB up -> it owns this

  const member = message.member ?? (await message.guild.members.fetch(message.author.id).catch(() => null));
  if (!member) return;
  // Only members still on the Age Please gate are verifying; ignore everyone else
  // (staff chatting, already-verified members) so we never embed or kick them.
  if (!member.roles.cache.has(AGE_PLEASE_ROLE_ID)) return;

  const content = message.content ?? '';
  const age = toIntYag(content);
  // Echoed back in the invalid embed; a zero-width space when the message was
  // empty (image-only) so the embed field is never blank.
  const entered = content.length ? content : '​';

  try {
    if (age === 0) {
      await message.channel.send({ embeds: [invalidEmbed(member, message.channel, entered)] });
    } else if (age < MIN_AGE) {
      const kickMsg =
        `We are sorry, but RPC is a ${MIN_AGE}+ server. You said you were ${age}. ` +
        'We would love to have you back once you meet our age requirement.';
      await message.channel.send({ content: kickMsg, allowedMentions: { parse: [] } });
      await maybeKick(member, kickMsg, sendLog);
    } else if (age > MAX_AGE) {
      await message.channel.send({ embeds: [overMaxEmbed(member, content)] });
    } else {
      await promote(member, sendLog, age);
    }
  } catch (err) {
    console.error(`[onboarding] age handling failed for ${member.user.tag}:`, err.message);
  }
}

// Under-min kick, but only after a sustained YAGPDB outage (guards a reconnect blip).
async function maybeKick(member, reason, sendLog) {
  if (failsafe.offlineForMs(member.guild) < MIN_OFFLINE_MS) {
    await onboardLog(sendLog, member, 'entered underage during a brief YAGPDB blip — not kicked');
    return;
  }
  try {
    await member.kick(`Failsafe (YAGPDB offline): ${reason}`);
    console.log(`[onboarding] kicked ${member.user.tag} (underage, YAGPDB offline)`);
    await onboardLog(sendLog, member, 'was **kicked** for entering an age below the minimum');
  } catch (err) {
    console.error(`[onboarding] could not kick ${member.user.tag}:`, err.message);
    if (sendLog) {
      await sendLog({
        content:
          `⚠️ Failsafe tried to kick underage member <@${member.id}> but failed: ${err.message}. ` +
          'Check that I have **Kick Members** and that my highest role is above theirs.',
        allowedMentions: { parse: [] },
      });
    }
  }
}

// Valid age: advance Age Please -> Rules Please.
async function promote(member, sendLog, age) {
  await swapRoles(member, RULES_PLEASE_ROLE_ID, AGE_PLEASE_ROLE_ID, `verified age ${age}`);
  console.log(`[onboarding] verified ${member.user.tag} (age ${age}) -> Rules Please`);
  await onboardLog(sendLog, member, `verified age (${age}) and advanced to **Rules Please**`);
}

// Rules reaction while YAGPDB is offline: Rules Please -> Newbie.
async function handleRulesReaction(reaction, user, sendLog) {
  if (!failsafe.ENABLED || !configured) return;
  if (user.bot) return;

  let msg = reaction.message;
  if (msg.partial) {
    try {
      msg = await msg.fetch();
    } catch {
      return; // message gone
    }
  }
  if (msg.id !== RULES_MESSAGE_ID) return;
  if (reaction.emoji.id !== RULES_EMOJI_ID) return; // custom emoji id; null for unicode

  const guild = msg.guild;
  if (!guild || failsafe.isYagpdbOnline(guild)) return;

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member || member.user.bot) return;
  // Only members on the Rules Please gate advance; others (never verified, or
  // already Newbie+) are skipped so a stray reaction can't jump the gate.
  if (!member.roles.cache.has(RULES_PLEASE_ROLE_ID)) return;

  try {
    await swapRoles(member, NEWBIE_ROLE_ID, RULES_PLEASE_ROLE_ID, 'agreed to the rules');
    console.log(`[onboarding] ${member.user.tag} agreed to rules -> Newbie`);
    await onboardLog(sendLog, member, 'agreed to the rules and advanced to **Newbie**');
  } catch (err) {
    console.error(`[onboarding] rules-reaction role swap failed for ${member.user.tag}:`, err.message);
  }
}

// Add one role and remove another, tolerating a missing role gracefully.
async function swapRoles(member, addId, removeId, reason) {
  const full = `Failsafe (YAGPDB offline): ${reason}`;
  if (addId && !member.roles.cache.has(addId)) await member.roles.add(addId, full);
  if (removeId && member.roles.cache.has(removeId)) await member.roles.remove(removeId, full);
}

// One orange failsafe embed to the log channel (respects the >>settings switch,
// like every other failsafe post).
async function onboardLog(sendLog, member, what) {
  if (!sendLog) return;
  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle('⚠️ Failsafe: onboarding')
    .setDescription(
      'YAGPDB appears to be **offline**, so I handled onboarding.\n\n' +
      `**Member:** <@${member.id}> (\`${member.user.username}\`)\n` +
      `**Action:** ${what}`
    )
    .setThumbnail(member.user.displayAvatarURL())
    .setTimestamp();
  await sendLog({ embeds: [embed] });
}

module.exports = {
  configured,
  channelId: AGE_VERIFY_CHANNEL_ID,
  handleAgeMessage,
  handleRulesReaction,
};
