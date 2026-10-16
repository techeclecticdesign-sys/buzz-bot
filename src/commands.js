// Prefix commands: the CircleBot-style `c!` commands (members, threadkill) and
// the `>>` info/admin commands (nicknames, roles, settings, failsafe). index.js
// routes a message here based on its prefix; everything else is internal.
const { EmbedBuilder } = require('discord.js');
const db = require('./db');
const failsafe = require('./failsafe');
const onboardingFailsafe = require('./onboardingFailsafe');
const pfpGuard = require('./pfpGuard');
const { buildSettingsMessage } = require('./embeds');
const { DESC_MAX, truncate, fitLines } = require('./format');
const config = require('./config');

const PREFIX = 'c!';
const NICK_PREFIX = '>>';

// Roles allowed to run `c!threadkill`.
const MOD_ROLES = config.idList('MOD_ROLES');
const MEMBER_LIST_CAP = 200;

// A no-arg guild.members.fetch() is a gateway opcode-8 chunk request that Discord
// rate-limits hard. Startup primes the cache and the intent keeps it live, so only
// refetch when the cache is incomplete, and dedupe concurrent callers behind one
// in-flight fetch.
const memberFetches = new Map(); // guild.id -> { promise, at }
const MEMBER_REFETCH_COOLDOWN_MS = 60_000;
async function ensureGuildMembers(guild) {
  if (guild.members.cache.size >= guild.memberCount) return; // cache complete
  const existing = memberFetches.get(guild.id);
  if (existing && Date.now() - existing.at < MEMBER_REFETCH_COOLDOWN_MS) {
    await existing.promise.catch(() => {});
    return;
  }
  const promise = guild.members.fetch();
  memberFetches.set(guild.id, { promise, at: Date.now() });
  try {
    await promise;
  } catch (err) {
    console.warn(`[members] fetch failed for ${guild.name}:`, err.message);
  }
}

// `c!members` (no role) shows a server-info card; `c!members @role` lists the
// members with that role. Both mirror Circle bot's embeds.
async function handleMembersCommand(message, args) {
  if (args.length === 0) {
    await sendServerInfoCard(message);
    return;
  }

  // Accept a role mention, a role id, or a (case-insensitive) role name.
  let role = message.mentions.roles.first();
  if (!role) {
    const query = args.join(' ').replace(/^@/, '');
    role =
      message.guild.roles.cache.get(query) ??
      message.guild.roles.cache.find(
        (r) => r.name.toLowerCase() === query.toLowerCase()
      );
  }
  if (!role) {
    await message.reply('Role not found. Usage: `c!members` or `c!members @role`');
    return;
  }

  // role.members only reflects the member cache; make sure it's complete first.
  await ensureGuildMembers(message.guild);
  const withRole = role.members;
  const listed = [...withRole.values()].slice(0, MEMBER_LIST_CAP);
  const lines = listed.map((m) => `@${m.user.username} \`${m.id}\``);

  const heading = `Listing ${listed.length} of ${withRole.size} members`;
  // The member list can exceed an embed's 4096-char description, so split it
  // into as many embeds as needed; the first carries the heading.
  const embeds = [];
  let body = '';
  const flush = () => {
    const embed = new EmbedBuilder()
      .setColor(role.color || 0x5865f2)
      .setTitle(`Showing members in ${role.name}`)
      .setDescription(`${embeds.length === 0 ? `${heading}\n\n` : ''}${body || '*none*'}`);
    if (embeds.length === 0)
      embed.setAuthor({ name: message.guild.name, iconURL: message.guild.iconURL() ?? undefined });
    embeds.push(embed);
    body = '';
  };
  for (const line of lines) {
    // Reserve room for the heading on the first embed.
    const budget = DESC_MAX - (embeds.length === 0 ? heading.length + 2 : 0);
    if (body.length + line.length + 1 > budget) flush();
    body += (body ? '\n' : '') + line;
  }
  flush();

  // Up to 10 embeds fit in one message; send in batches to be safe.
  for (let i = 0; i < embeds.length; i += 10) {
    await message.channel.send({
      embeds: embeds.slice(i, i + 10),
      allowedMentions: { parse: [] },
    });
  }
}

// Server-info card for bare `c!members`: name + icon, member/online/boost counts.
async function sendServerInfoCard(message) {
  const guild = message.guild;
  const icon = guild.iconURL({ size: 512 }) ?? undefined;

  // Discord's own online tally (approximate_presence_count, via ?with_counts).
  // This matches what other bots report; counting our local presence cache
  // undercounts because the gateway only delivers a subset of presences.
  let onlineValue = '—';
  try {
    await guild.fetch();
    if (typeof guild.approximatePresenceCount === 'number')
      onlineValue = guild.approximatePresenceCount.toLocaleString();
  } catch (err) {
    console.warn('[members] could not fetch presence count:', err.message);
  }

  // Icon in the author line only — a thumbnail/full image renders extra copies.
  const boostTier = guild.premiumTier ? ` (Level ${guild.premiumTier})` : '';
  const embed = new EmbedBuilder()
    .setColor(0x5865f2)
    .setAuthor({ name: guild.name, iconURL: icon })
    .addFields(
      { name: 'Member Count', value: guild.memberCount.toLocaleString(), inline: true },
      { name: 'Online Members', value: onlineValue, inline: true },
      { name: 'Server Boosts', value: `${(guild.premiumSubscriptionCount ?? 0).toLocaleString()}${boostTier}`, inline: true },
    );

  await message.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

// `c!threadkill <thread id>` — staff-only. Deletes ONLY threads: a resolved
// channel is deleted solely when `isThread()` is true, so regular channels are
// never touched, and a message id (which resolves to no channel) is a no-op.
async function handleThreadkillCommand(message, args) {
  const isStaff = MOD_ROLES.length > 0 && message.member?.roles.cache.hasAny(...MOD_ROLES);
  if (!isStaff) {
    await message.reply('You do not have permission to use this command.');
    return;
  }

  // Accept a raw id or a <#id> channel mention.
  const id = (args[0] ?? '').match(/\d{5,}/)?.[0];
  if (!id) {
    await message.reply('Usage: `c!threadkill <thread id>`');
    return;
  }

  let channel = message.guild.channels.cache.get(id) ?? null;
  if (!channel) {
    try {
      channel = await message.guild.channels.fetch(id);
    } catch {
      channel = null;
    }
  }
  if (!channel) {
    await message.reply(`No thread found with id \`${id}\`. Nothing was deleted.`);
    return;
  }

  // Hard guard: refuse to delete anything that isn't a thread.
  if (!channel.isThread()) {
    await message.reply(
      `\`${id}\` is **${channel.name ?? 'that channel'}**, which is not a thread. Nothing was deleted.`
    );
    return;
  }

  // Only delete empty threads. Forum/media posts carry a starter message that
  // shares the thread's id — ignore that; any other message means it's not
  // empty. This also covers regular threads (which fetch as zero messages when
  // empty, since their starter lives in the parent channel).
  try {
    const recent = await channel.messages.fetch({ limit: 3 });
    const others = recent.filter((m) => m.id !== channel.id);
    if (others.size > 0) {
      await message.reply(
        `Thread **${channel.name}** (\`${id}\`) is not empty. Nothing was deleted.`
      );
      return;
    }
  } catch (err) {
    await message.reply(
      `Couldn't verify whether thread \`${id}\` is empty: ${err.message}. Nothing was deleted.`
    );
    return;
  }

  const name = channel.name;
  try {
    await channel.delete(`c!threadkill by ${message.author.tag} (${message.author.id})`);
    await message.reply(`Deleted thread **${name}** (\`${id}\`).`);
  } catch (err) {
    await message.reply(`Failed to delete thread \`${id}\`: ${err.message}`);
  }
}

async function handleCommand(message) {
  const [cmd, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  try {
    if (cmd.toLowerCase() === 'members') await handleMembersCommand(message, args);
    else if (cmd.toLowerCase() === 'threadkill') await handleThreadkillCommand(message, args);
  } catch (err) {
    console.error(`[command] ${cmd} error:`, err.message);
  }
}

async function handleSettingsCommand(message) {
  if (message.guild.ownerId !== message.author.id) {
    await message.reply('Only the server owner can view or change logger settings.');
    return;
  }
  const settings = await db.getGuildSettings();
  await message.channel.send(buildSettingsMessage(settings));
}

// >>failsafe — owner-only readout of YAGPDB detection so the "variants of
// yagpdb" matching can be verified without waiting for a real outage.
async function handleFailsafeCommand(message) {
  if (message.guild.ownerId !== message.author.id) {
    await message.reply('Only the server owner can view failsafe status.');
    return;
  }
  const s = failsafe.describeStatus(message.guild);
  const role = message.guild.roles.cache.get(s.roleId);
  const foundLines = s.found.length
    ? s.found.map((m) => `• \`${m.user.username}\` (${m.id}) — **${failsafe.statusLabel(m)}**`).join('\n')
    : '*none detected*';

  const embed = new EmbedBuilder()
    .setColor(s.active ? 0xe67e22 : 0x2ecc71)
    .setTitle('Failsafe status')
    .setDescription(
      `**Enabled:** ${s.enabled ? 'yes' : 'no — `FAILSAFE_ENABLED=false` (Presence intent not requested)'}\n` +
      `**YAGPDB bots detected:** ${s.found.length}\n` +
      `**Any online:** ${s.online.length > 0 ? 'yes' : 'no'}\n` +
      `**Currently active:** ${s.active
        ? '🟠 YES — the next member to join will get Age Please'
        : '🟢 no — YAGPDB is handling joins'}\n\n` +
      `**Detected bots:**\n${foundLines}\n\n` +
      `**Age Please role:** ${role ? `${role} \`${role.name}\`` : `\`${s.roleId}\` — ⚠️ *not found*`}\n` +
      `**Onboarding failsafe:** ${onboardingFailsafe.configured
        ? `armed (age channel <#${onboardingFailsafe.channelId}>)`
        : 'inactive — `AGE_VERIFY_CHANNEL_ID` unset'}`
    )
    .setFooter({
      text: s.found.length === 0
        ? 'No YAGPDB match found — the failsafe would treat it as offline. Check the bot shares this server.'
        : 'Matches any bot whose name contains “yagpdb”, ignoring the #discriminator.',
    })
    .setTimestamp();
  await message.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

// Resolve the target of a >> command: a mention, a raw user id, or a
// (case-insensitive) username / current nickname.
async function resolveUser(message, args) {
  const mentioned = message.mentions.users.first();
  if (mentioned) return mentioned;

  const q = args.join(' ').replace(/^@/, '').trim();
  if (!q) return null;

  if (/^\d{5,}$/.test(q)) {
    const byId = await message.client.users.fetch(q).catch(() => null);
    if (byId) return byId;
  }

  await ensureGuildMembers(message.guild);
  const member = message.guild.members.cache.find(
    (m) =>
      m.user.username.toLowerCase() === q.toLowerCase() ||
      (m.nickname && m.nickname.toLowerCase() === q.toLowerCase())
  );
  return member?.user ?? null;
}

async function handleNicknamesCommand(message, args) {
  const user = await resolveUser(message, args);
  if (!user) {
    await message.reply('User not found. Usage: `>>nicknames @user`');
    return;
  }
  const history = await db.getNicknameHistory(user.id);
  const member = await message.guild.members.fetch(user.id).catch(() => null);

  const lines = history.map((r) => {
    const nick = r.nickname ?? '*(reset to username)*';
    return `**${nick}** — <t:${Math.floor(new Date(r.changed_at).getTime() / 1000)}:f>`;
  });

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle(`Nickname history — ${user.tag}`)
    .setThumbnail(user.displayAvatarURL())
    .setDescription(
      `**Current nickname:** ${member?.nickname ?? '*(none — uses username)*'}\n` +
      `**Username:** ${user.username}\n\n` +
      (lines.length ? `**Changes recorded:**\n${fitLines(lines)}` : '*No nickname changes recorded yet.*')
    );
  await message.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function handleRolesCommand(message, args) {
  const user = await resolveUser(message, args);
  if (!user) {
    await message.reply('User not found. Usage: `>>roles @user`');
    return;
  }
  const member = await message.guild.members.fetch(user.id).catch(() => null);
  const history = await db.getRoleHistory(user.id);

  const currentRoles = member
    ? [...member.roles.cache.values()]
        .filter((r) => r.id !== message.guild.id)
        .sort((a, b) => b.position - a.position)
        .map((r) => r.name)
    : [];

  const changeLines = history.map((r) => {
    const sign = r.action === 'add' ? '➕' : '➖';
    return `${sign} ${r.role_name ?? r.role_id} — <t:${Math.floor(new Date(r.changed_at).getTime() / 1000)}:f>`;
  });

  // Description caps at 4096: the roles list is truncated and the history block
  // gets a smaller budget so the two can never overflow together (a member can
  // hold up to 250 roles — the join alone can pass 5000 chars).
  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle(`Roles — ${user.tag}`)
    .setThumbnail(user.displayAvatarURL())
    .setDescription(
      (member
        ? `**Current roles (${currentRoles.length}):** ${currentRoles.length ? truncate(currentRoles.join(', '), 1000) : '*none*'}`
        : '*User is no longer in the server.*') +
      '\n\n' +
      (changeLines.length ? `**Recent role changes:**\n${fitLines(changeLines, 2800)}` : '*No role changes recorded yet.*')
    );
  await message.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function handleNickPrefixCommand(message) {
  const [cmd, ...args] = message.content.slice(NICK_PREFIX.length).trim().split(/\s+/);
  const c = cmd.toLowerCase();
  try {
    if (await pfpGuard.handleCommand(message, c, args)) return;
    if (c === 'nicknames' || c === 'nicks' || c === 'nick') await handleNicknamesCommand(message, args);
    else if (c === 'roles' || c === 'role') await handleRolesCommand(message, args);
    else if (c === 'settings' || c === 'config') await handleSettingsCommand(message);
    else if (c === 'failsafe' || c === 'jarvis' || c === 'status') await handleFailsafeCommand(message);
    else if (c === 'help' || c === '')
      await message.reply(
        'Commands: `>>nicknames @user`, `>>roles @user`, `>>settings` (owner), `>>failsafe` (owner), ' +
        '`>>pfpban` / `>>pfpunban` / `>>pfplist` / `>>pfpcheck` (staff)'
      );
  } catch (err) {
    console.error(`[nick-command] ${cmd} error:`, err.message);
  }
}

module.exports = {
  PREFIX,
  NICK_PREFIX,
  handleCommand,
  handleNickPrefixCommand,
};
