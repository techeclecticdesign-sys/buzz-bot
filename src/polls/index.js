const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} = require('discord.js');
const db = require('./db');

const ENABLED = process.env.POLLS_ENABLED !== 'false';
const EPHEMERAL = MessageFlags.Ephemeral;
const MAX_CHOICES = 20;
const MAX_QUESTION_LENGTH = 1000;
const MAX_CHOICE_LENGTH = 100;
const POLL_OPEN_SINGLE = 0x00fffe;
const POLL_OPEN_MULTI = 0x00fffd;
const POLL_CLOSED = 0xfa2626;
const MAX_DURATION_MS = 7 * 24 * 60 * 60 * 1000;
const timers = new Map();
let botClient = null;

async function init() {
  await db.init();
}

function commandData() {
  const poll = new SlashCommandBuilder()
    .setName('poll')
    .setDescription('Create an anonymous timed poll')
    .addStringOption((o) =>
      o.setName('question').setDescription('The poll question').setRequired(true).setMaxLength(MAX_QUESTION_LENGTH)
    )
    .addStringOption((o) =>
      o.setName('duration').setDescription('How long voting stays open: 10m, 3h, 1d, max 7d').setRequired(true)
    )
    .addIntegerOption((o) =>
      o
        .setName('votes')
        .setDescription('Votes each person may cast')
        .setRequired(true)
        .setMinValue(1)
        .setMaxValue(MAX_CHOICES)
    )
    .addStringOption((o) =>
      o.setName('choice1').setDescription('Choice 1').setRequired(true).setMaxLength(MAX_CHOICE_LENGTH)
    )
    .addStringOption((o) =>
      o.setName('choice2').setDescription('Choice 2').setRequired(true).setMaxLength(MAX_CHOICE_LENGTH)
    );

  for (let i = 3; i <= MAX_CHOICES; i++) {
    poll.addStringOption((o) =>
      o.setName(`choice${i}`).setDescription(`Choice ${i}`).setRequired(false).setMaxLength(MAX_CHOICE_LENGTH)
    );
  }

  const close = new SlashCommandBuilder()
    .setName('closepoll')
    .setDescription('Close one of the bot polls early')
    .addStringOption((o) =>
      o.setName('id').setDescription('Poll ID, or the poll message ID').setRequired(true)
    );

  return [poll, close].map((c) => c.toJSON());
}

function parseDuration(input) {
  const match = String(input ?? '').trim().replace(/\s+/g, '').match(/^(\d+)([smhdw])?$/i);
  if (!match) return null;
  const amount = Number(match[1]);
  if (!Number.isSafeInteger(amount) || amount <= 0) return null;
  const unit = (match[2] ?? 'm').toLowerCase();
  const multipliers = {
    s: 1000,
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000,
  };
  return Math.min(amount * multipliers[unit], MAX_DURATION_MS);
}

function truncate(str, max) {
  if (!str) return str;
  return str.length > max ? `${str.slice(0, max - 1)}...` : str;
}

function choiceEmoji(index) {
  return String.fromCodePoint(0x1f1e6 + index);
}

function normalizePoll(poll) {
  return {
    pollId: poll.pollId ?? poll.poll_id,
    guildId: poll.guildId ?? poll.guild_id,
    channelId: poll.channelId ?? poll.channel_id,
    messageId: poll.messageId ?? poll.message_id,
    creatorId: poll.creatorId ?? poll.creator_id,
    question: poll.question,
    choices: poll.choices,
    votesAllowed: poll.votesAllowed ?? poll.votes_allowed,
    endsAt: poll.endsAt ?? poll.ends_at,
    active: poll.active,
  };
}

function progressbar(percentage) {
  const filled = Math.round(percentage / 10);
  return `${'\u2593'.repeat(filled)}${'\u2591'.repeat(10 - filled)}`;
}

function countsByChoice(countRows) {
  const counts = new Map();
  for (const row of countRows) counts.set(row.choice_index, Number(row.count) || 0);
  return counts;
}

async function pollEmbed(rawPoll, { closed = false } = {}) {
  const poll = normalizePoll(rawPoll);
  const counts = closed ? countsByChoice(await db.getVoteCounts(poll.pollId)) : null;
  const lines = [
    '**Question**',
    poll.question,
    '',
    '**Choices**',
    ...poll.choices.map((choice, i) => `${choiceEmoji(i)} ${choice}`),
  ];

  if (closed && counts) {
    const allVotes = [...counts.values()].reduce((sum, count) => sum + count, 0);
    lines.push('', '**Final Result**');
    for (let i = 0; i < poll.choices.length; i++) {
      const count = counts.get(i) ?? 0;
      const percentage = allVotes ? (count / allVotes) * 100 : 0;
      lines.push(`${choiceEmoji(i)} ${progressbar(percentage)} [${count} \u2022 ${percentage.toFixed(1)}%]`);
    }
  }

  const endUnix = Math.floor(new Date(poll.endsAt).getTime() / 1000);
  if (closed) lines.push('', ':alarm_clock: Poll already ended');
  else lines.push('', `:alarm_clock: Ends <t:${endUnix}:R>`);

  if (poll.votesAllowed > 1) lines.push(`:white_check_mark: Up to ${poll.votesAllowed} choices allowed`);
  else lines.push(':no_entry: Multiple choices not allowed');
  if (closed) lines.push(':lock: No other votes allowed');

  return new EmbedBuilder()
    .setColor(closed ? POLL_CLOSED : poll.votesAllowed > 1 ? POLL_OPEN_MULTI : POLL_OPEN_SINGLE)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `Poll ID: ${poll.pollId}` });
}

function pollComponents(rawPoll, { disabled = false } = {}) {
  const poll = normalizePoll(rawPoll);
  const rows = [];
  for (let i = 0; i < poll.choices.length; i += 5) {
    const row = new ActionRowBuilder();
    for (let j = i; j < Math.min(i + 5, poll.choices.length); j++) {
      row.addComponents(
        new ButtonBuilder()
          .setCustomId(`poll:vote:${poll.pollId}:${j}`)
          .setEmoji(choiceEmoji(j))
          .setLabel(truncate(poll.choices[j], 80))
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(disabled)
      );
    }
    rows.push(row);
  }
  return rows;
}

function buildPollMessage(poll, { closed = false } = {}) {
  return pollEmbed(poll, { closed }).then((embed) => ({
    embeds: [embed],
    components: pollComponents(poll, { disabled: closed }),
    allowedMentions: { parse: [] },
  }));
}

function scheduleClose(rawPoll) {
  if (!botClient) return;
  const poll = normalizePoll(rawPoll);
  if (!poll.active) return;
  clearTimeout(timers.get(poll.pollId));
  const delay = Math.max(0, new Date(poll.endsAt).getTime() - Date.now());
  const timer = setTimeout(() => closeAndRender(poll.pollId), delay);
  timer.unref?.();
  timers.set(poll.pollId, timer);
}

async function start(client) {
  botClient = client;
  const activePolls = await db.getActivePolls();
  for (const poll of activePolls) scheduleClose(poll);
  console.log(`[polls] scheduled ${activePolls.length} active poll(s).`);
}

async function closeAndRender(pollId) {
  clearTimeout(timers.get(pollId));
  timers.delete(pollId);
  const poll = await db.closePoll(pollId);
  if (!poll?.message_id || !botClient) return poll;

  try {
    const channel = botClient.channels.cache.get(poll.channel_id) ?? (await botClient.channels.fetch(poll.channel_id));
    if (!channel?.messages) return poll;
    const message = await channel.messages.fetch(poll.message_id);
    await message.edit(await buildPollMessage(poll, { closed: true }));
  } catch (err) {
    console.warn(`[polls] could not edit closed poll ${pollId}:`, err.message);
  }
  return poll;
}

function collectChoices(interaction) {
  const choices = [];
  for (let i = 1; i <= MAX_CHOICES; i++) {
    const value = interaction.options.getString(`choice${i}`);
    if (!value) continue;
    const trimmed = value.trim();
    if (trimmed) choices.push(truncate(trimmed, MAX_CHOICE_LENGTH));
  }
  return choices;
}

async function cmdPoll(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Polls can only be created in a server.', flags: EPHEMERAL });
    return;
  }

  const duration = parseDuration(interaction.options.getString('duration'));
  const votesAllowed = interaction.options.getInteger('votes');
  const question = truncate(interaction.options.getString('question').trim(), MAX_QUESTION_LENGTH);
  const choices = collectChoices(interaction);

  if (!duration) {
    await interaction.reply({ content: 'Use a duration like `10m`, `3h`, or `1d` (maximum 7 days).', flags: EPHEMERAL });
    return;
  }
  if (!question) {
    await interaction.reply({ content: 'The poll question cannot be blank.', flags: EPHEMERAL });
    return;
  }
  if (choices.length < 2) {
    await interaction.reply({ content: 'A poll needs at least 2 choices.', flags: EPHEMERAL });
    return;
  }
  if (votesAllowed > choices.length) {
    await interaction.reply({
      content: `Votes per person cannot be higher than the number of choices (${choices.length}).`,
      flags: EPHEMERAL,
    });
    return;
  }

  await interaction.deferReply();
  const poll = {
    pollId: await db.generatePollId(),
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    messageId: null,
    creatorId: interaction.user.id,
    question,
    choices,
    votesAllowed,
    endsAt: new Date(Date.now() + duration),
    active: true,
  };

  await db.createPoll(poll);
  const message = await interaction.editReply(await buildPollMessage(poll));
  poll.messageId = message.id;
  await db.setPollMessage(poll.pollId, message.id);
  scheduleClose(poll);
}

function canClosePoll(interaction, poll) {
  if (interaction.user.id === poll.creator_id) return true;
  if (interaction.guild?.ownerId === interaction.user.id) return true;
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages) ?? false;
}

async function cmdClosePoll(interaction) {
  if (!interaction.inGuild()) {
    await interaction.reply({ content: 'Polls can only be closed in a server.', flags: EPHEMERAL });
    return;
  }
  const id = interaction.options.getString('id').trim();
  let poll = await db.getPoll(id);
  if (!poll) poll = await db.getPollByMessage(id);
  if (!poll || poll.guild_id !== interaction.guildId) {
    await interaction.reply({ content: 'No poll found with that ID in this server.', flags: EPHEMERAL });
    return;
  }
  if (!canClosePoll(interaction, poll)) {
    await interaction.reply({ content: 'Only the poll creator, server owner, or Manage Messages users can close it.', flags: EPHEMERAL });
    return;
  }
  if (!poll.active) {
    await interaction.reply({ content: 'That poll is already closed.', flags: EPHEMERAL });
    return;
  }

  await interaction.deferReply({ flags: EPHEMERAL });
  await closeAndRender(poll.poll_id);
  await interaction.editReply(`Closed poll **${poll.poll_id}** and posted the final result on the poll message.`);
}

function voteStatusText(status, poll, votes) {
  const selected = votes.map((i) => `${choiceEmoji(i)} ${poll.choices[i]}`).join(', ') || 'none';
  if (status === 'limit') {
    return `You already used all ${poll.votes_allowed} vote(s). Tap one of your current choices to remove it first: ${selected}`;
  }
  return 'That vote could not be recorded.';
}

async function onVote(interaction) {
  const [, , pollId, choice] = interaction.customId.split(':');
  const choiceIndex = Number(choice);
  if (!Number.isInteger(choiceIndex)) {
    await interaction.reply({ content: 'That poll button is invalid.', flags: EPHEMERAL });
    return;
  }

  const result = await db.toggleVote(pollId, interaction.user.id, choiceIndex);
  if (result.status === 'missing') {
    await interaction.reply({ content: 'That poll no longer exists.', flags: EPHEMERAL });
    return;
  }
  if (result.status === 'closed') {
    closeAndRender(pollId).catch((err) => console.warn(`[polls] close after late vote failed: ${err.message}`));
    await interaction.reply({ content: 'That poll is already closed.', flags: EPHEMERAL });
    return;
  }
  if (result.status === 'invalid') {
    await interaction.reply({ content: 'That choice is not part of this poll.', flags: EPHEMERAL });
    return;
  }
  if (result.status === 'added' || result.status === 'removed') {
    await interaction.deferUpdate();
    return;
  }

  await interaction.reply({
    content: voteStatusText(result.status, result.poll, result.votes),
    flags: EPHEMERAL,
  });
}

async function handleInteraction(interaction) {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'poll') {
        await cmdPoll(interaction);
        return true;
      }
      if (interaction.commandName === 'closepoll') {
        await cmdClosePoll(interaction);
        return true;
      }
    }
    if (interaction.isButton() && interaction.customId.startsWith('poll:vote:')) {
      await onVote(interaction);
      return true;
    }
    return false;
  } catch (err) {
    console.error('[polls] interaction error:', err.message);
    try {
      const msg = { content: 'Something went wrong with that poll action. Try again in a moment.' };
      if (interaction.deferred || interaction.replied) await interaction.editReply(msg);
      else await interaction.reply({ ...msg, flags: EPHEMERAL });
    } catch {
      /* interaction already gone */
    }
    return true;
  }
}

module.exports = { ENABLED, init, start, commandData, handleInteraction };
