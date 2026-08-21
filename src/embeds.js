// Embed factories for member/name/role changes, joins/leaves, and the settings
// panel. Pure builders: they take Discord objects + plain values and return an
// EmbedBuilder (or a message payload), with no I/O of their own.
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { truncate } = require('./format');

// Mentions inside an embed never ping, so these are safe to post without
// allowedMentions.
function memberHeader(user) {
  return `**Member:** <@${user.id}> (\`${user.username}\`)\n**User ID:** ${user.id}`;
}

function nicknameEmbed(member, before, after) {
  return new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle('Nickname changed')
    .setThumbnail(member.user.displayAvatarURL())
    .setDescription(memberHeader(member.user))
    .addFields(
      { name: 'Before', value: before ?? '*(none — used username)*', inline: true },
      { name: 'After', value: after ?? '*(reset to username)*', inline: true }
    )
    .setTimestamp();
}

// One embed per role change: avatar + @username author line, a plain-language
// sentence, user ID in the footer.
function roleChangeEmbed(member, roleId, roleName, action) {
  const role = roleName ?? `<@&${roleId}>`;
  const sentence =
    action === 'add'
      ? `<@${member.id}> was given the ${role} role.`
      : `<@${member.id}> was removed from the ${role} role.`;
  return new EmbedBuilder()
    .setColor(action === 'add' ? 0x2ecc71 : 0xe74c3c)
    .setAuthor({ name: `@${member.user.username}`, iconURL: member.user.displayAvatarURL() })
    .setDescription(sentence)
    .setFooter({ text: `User ID: ${member.id}` })
    .setTimestamp();
}

// Join/leave cards: @username + avatar author line, a "joined/left" sentence, an
// Account Created / Member Count pair, user id in the footer. `<t:…:f>` renders
// each viewer's local time.
function memberJoinEmbed(member) {
  const created = Math.floor(member.user.createdTimestamp / 1000);
  return new EmbedBuilder()
    .setColor(0x2ecc71)
    .setAuthor({ name: `@${member.user.username}`, iconURL: member.user.displayAvatarURL() })
    .setDescription(`<@${member.id}> has joined the server!`)
    .addFields(
      { name: 'Account Created', value: `<t:${created}:f>`, inline: true },
      { name: 'Member Count', value: member.guild.memberCount.toLocaleString(), inline: true }
    )
    .setFooter({ text: `User ID: ${member.id}` })
    .setTimestamp();
}

// The inverse of the join card (red). memberCount has already been decremented
// by the time this fires, so it reflects the post-leave total. A partial/uncached
// member may lack joinedTimestamp and a complete role list, so both are optional.
function memberLeaveEmbed(member) {
  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setAuthor({ name: `@${member.user.username}`, iconURL: member.user.displayAvatarURL() })
    .setDescription(`<@${member.id}> has left the server.`)
    .setFooter({ text: `User ID: ${member.id}` })
    .setTimestamp();

  const joined = member.joinedTimestamp
    ? `<t:${Math.floor(member.joinedTimestamp / 1000)}:f>`
    : '*(unknown — not cached)*';
  embed.addFields(
    { name: 'Joined Server', value: joined, inline: true },
    { name: 'Member Count', value: member.guild.memberCount.toLocaleString(), inline: true }
  );

  // Roles held at the time they left (minus @everyone), when the member was
  // cached. Handy for spotting whether a verified/staff member left.
  const roles = member.roles?.cache
    ? [...member.roles.cache.values()]
        .filter((r) => r.id !== member.guild.id)
        .sort((a, b) => b.position - a.position)
        .map((r) => r.name)
    : [];
  if (roles.length)
    embed.addFields({ name: `Roles (${roles.length})`, value: truncate(roles.join(', '), 1024) });

  return embed;
}

function profileNameEmbed(user, c) {
  const embed = new EmbedBuilder()
    .setColor(0x1abc9c)
    .setTitle('Account name changed')
    .setThumbnail(user.displayAvatarURL())
    .setDescription(memberHeader(user))
    .setTimestamp();
  if (c.usernameChanged)
    embed.addFields({
      name: 'Username',
      value: `\`${c.oldUsername ?? '(unknown)'}\` → \`${c.newUsername ?? '(none)'}\``,
    });
  if (c.globalChanged)
    embed.addFields({
      name: 'Display name',
      value: `${c.oldGlobal ?? '*(none)*'} → ${c.newGlobal ?? '*(none)*'}`,
    });
  return embed;
}

// --- Settings panel (>>settings) ---

// log_to_channel is the master switch for posting to the log channel; the rest
// describe what's posted when it's on. Message edits/deletes and name changes are
// always logged; role changes are the one per-type opt-in. All owner-toggled.
function buildSettingsMessage(settings) {
  const posting = settings.log_to_channel;
  const embed = new EmbedBuilder()
    .setColor(posting ? 0x2ecc71 : 0x95a5a6)
    .setTitle('Logger settings')
    .setDescription(
      `${posting ? '🟢' : '⚪'} **Log channel posting** — ${posting ? 'On' : 'Off'}\n` +
      (posting
        ? ''
        : '_Paused — messages are still archived to the database, but nothing is posted to the log channel until you switch this back on._\n') +
      '\nWhen posting is on, the log channel receives:\n' +
      '✅ **Message edits** — always on\n' +
      '✅ **Message deletions** — always on\n' +
      '✅ **Name changes** — always on _(nickname, username & display name)_\n' +
      '✅ **Joins & leaves** — always on\n' +
      `${settings.log_role_changes ? '🟢' : '⚪'} **Role changes** — ${settings.log_role_changes ? 'On' : 'Off'}`
    )
    .setFooter({ text: 'Only the server owner can change these. Tap a switch below to toggle.' });

  const disabled = (id, label) =>
    new ButtonBuilder().setCustomId(id).setLabel(label).setStyle(ButtonStyle.Success).setDisabled(true);

  const masterRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('settings:toggle:channel')
      .setLabel(`Log channel posting: ${posting ? 'On' : 'Off'}`)
      .setStyle(posting ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
  const typesRow = new ActionRowBuilder().addComponents(
    disabled('settings:noop:edits', 'Edits: On'),
    disabled('settings:noop:deletes', 'Deletions: On'),
    disabled('settings:noop:names', 'Name changes: On'),
    new ButtonBuilder()
      .setCustomId('settings:toggle:role')
      .setLabel(`Role changes: ${settings.log_role_changes ? 'On' : 'Off'}`)
      .setStyle(settings.log_role_changes ? ButtonStyle.Success : ButtonStyle.Secondary),
  );
  return { embeds: [embed], components: [masterRow, typesRow] };
}

module.exports = {
  memberHeader,
  nicknameEmbed,
  roleChangeEmbed,
  memberJoinEmbed,
  memberLeaveEmbed,
  profileNameEmbed,
  buildSettingsMessage,
};
