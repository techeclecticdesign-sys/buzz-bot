// /verify-adult — an age-restricted (NSFW) slash command. Discord only lets a
// member run it once Discord's own age assurance has them as 18+, and only from
// an age-restricted channel (guild commands never appear in DMs). When one goes
// through, the bot posts who ran it to ADULT_CHECK_CHANNEL_ID for staff.
//
// Bots are never told a user's age: the interaction arriving at all is the
// signal. The channel re-check below covers the half of Discord's gate the bot
// can actually see.
const { EmbedBuilder, MessageFlags, SlashCommandBuilder } = require('discord.js');
const config = require('./config');
const { memberHeader } = require('./embeds');

const ENABLED = config.bool('ADULT_CHECK_ENABLED', true);
const CHANNEL_ID = (process.env.ADULT_CHECK_CHANNEL_ID || '1534208635889123548').trim();
const COMMAND = 'verify-adult';
const EPHEMERAL = MessageFlags.Ephemeral;

function commandData() {
  return [
    new SlashCommandBuilder()
      .setName(COMMAND)
      .setDescription("Confirm you're 18+ using Discord's age verification")
      .setNSFW(true)
      .toJSON(),
  ];
}

// Threads have no nsfw flag of their own; they inherit their parent's.
function isAgeRestricted(channel) {
  if (!channel) return false;
  return Boolean(channel.isThread?.() ? channel.parent?.nsfw : channel.nsfw);
}

function adultCheckEmbed(user, channelId) {
  return new EmbedBuilder()
    .setColor(0x2ecc71)
    .setAuthor({ name: `@${user.username}`, iconURL: user.displayAvatarURL() })
    .setDescription(
      `${memberHeader(user)}\n\nPassed Discord's 18+ age check via \`/${COMMAND}\` in <#${channelId}>.`
    )
    .setTimestamp();
}

async function handleInteraction(interaction) {
  if (!interaction.isChatInputCommand() || interaction.commandName !== COMMAND) return false;
  try {
    const channel =
      interaction.channel ?? (await interaction.client.channels.fetch(interaction.channelId).catch(() => null));
    if (!interaction.inGuild() || !isAgeRestricted(channel)) {
      await interaction.reply({ content: 'Run this from an age-restricted channel.', flags: EPHEMERAL });
      return true;
    }
    const log = await interaction.client.channels.fetch(CHANNEL_ID);
    await log.send({ embeds: [adultCheckEmbed(interaction.user, interaction.channelId)] });
    await interaction.reply({ content: "Discord confirms you're 18+. Staff have been notified.", flags: EPHEMERAL });
  } catch (err) {
    console.error('[adult-check] interaction error:', err.message);
    try {
      const msg = { content: "Couldn't notify staff just now. Try again in a moment." };
      if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
      else await interaction.reply({ ...msg, flags: EPHEMERAL });
    } catch {
      /* interaction already gone */
    }
  }
  return true;
}

module.exports = { ENABLED, CHANNEL_ID, COMMAND, commandData, isAgeRestricted, adultCheckEmbed, handleInteraction };
