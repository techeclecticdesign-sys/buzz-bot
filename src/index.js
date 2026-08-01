require('dotenv').config();
const {
  AuditLogEvent,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  EmbedBuilder,
  AttachmentBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
} = require('discord.js');
const db = require('./db');
const jsonArchive = require('./jsonArchive');
const { isIgnoredMessage } = require('./ignoredChannels');
const failsafe = require('./failsafe');
const advertFailsafe = require('./advertFailsafe');
const onboardingFailsafe = require('./onboardingFailsafe');
const retention = require('./retention');
const linkCheck = require('./checkLinks');
const game = require('./game');
const polls = require('./polls');

const TOKEN = process.env.DISCORD_TOKEN;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const IGNORE_BOTS = process.env.IGNORE_BOTS === 'true';
// Logging (message archive + edit/delete embeds + member/name tracking) is
// optional so the bot can run game-only. When off, LOG_CHANNEL_ID and the
// privileged message intents aren't required.
const LOGGING_ENABLED = process.env.LOGGING_ENABLED !== 'false';

if (!TOKEN || !process.env.DATABASE_URL) {
  console.error('Missing required env vars: DISCORD_TOKEN, DATABASE_URL');
  process.exit(1);
}
if (LOGGING_ENABLED && !LOG_CHANNEL_ID) {
  console.error('LOGGING_ENABLED but LOG_CHANNEL_ID is unset — set it, or set LOGGING_ENABLED=false.');
  process.exit(1);
}

// Intents are requested per enabled feature, so a game-only bot needs no
// privileged intents. Logging and the failsafe both read messages/members; the
// failsafe additionally needs presence to see whether YAGPDB is online.
const needMessageIntents = LOGGING_ENABLED || failsafe.ENABLED;
const intents = [GatewayIntentBits.Guilds];
if (needMessageIntents) {
  intents.push(
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers
  );
}
// Presence sees whether YAGPDB is online; reactions drive the onboarding
// failsafe's rules-agreement step (react to the rules message -> Newbie).
if (failsafe.ENABLED) {
  intents.push(GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildMessageReactions);
}

const client = new Client({
  intents,
  // Partials are required so update/delete events still fire for messages
  // that aren't in discord.js's in-memory cache — the whole point of this bot.
  // GuildMember lets member-update events fire for uncached members too, and
  // Reaction/Message let the rules reaction fire on the (old, uncached) rules
  // message.
  partials: [Partials.Message, Partials.Channel, Partials.GuildMember, Partials.Reaction],
});

function truncate(str, max) {
  if (!str) return str;
  return str.length > max ? str.slice(0, max - 1) + '…' : str;
}

function fieldText(content) {
  return truncate(content, 1024) || '*(no text content)*';
}

// Discord caps an embed description at 4096 chars (and the whole embed at 6000).
// We budget content into the description against a limit kept a little below
// 4096 so the trailing ellipsis, surrogate-pair miscounts, or any off-by-one can
// never push a real post over the cap and make Discord reject the embed — which
// would drop the log entry entirely. Losing the post is the one thing we won't
// risk, so we truncate conservatively instead.
const DESC_LIMIT = 4096;
const DESC_SAFETY_BUFFER = 96;
const DESC_MAX = DESC_LIMIT - DESC_SAFETY_BUFFER; // 4000

// Fit `before` and `after` into `budget` chars total, truncating equally: each
// may use up to half the budget, and whatever one leaves unused is handed to the
// other. Only an oversized side loses text, so a short `before` is never cut to
// match a long `after`. The two returned strings always sum to <= budget.
function splitTruncate(before, after, budget) {
  if (budget <= 0) return ['', ''];
  if (before.length + after.length <= budget) return [before, after];
  const half = Math.floor(budget / 2);
  let beforeMax, afterMax;
  if (before.length <= half) {
    beforeMax = before.length;
    afterMax = budget - before.length;
  } else if (after.length <= half) {
    afterMax = after.length;
    beforeMax = budget - after.length;
  } else {
    beforeMax = half;
    afterMax = budget - half;
  }
  return [truncate(before, beforeMax), truncate(after, afterMax)];
}

function attachmentList(attachments) {
  if (!attachments?.length) return null;
  // Truncate by whole lines so a markdown link is never cut in half.
  let out = '';
  for (const a of attachments) {
    const line = `[${a.name}](${a.url})`;
    if (out.length + line.length + 3 > 1024) {
      out += '\n…';
      break;
    }
    out += (out ? '\n' : '') + line;
  }
  return out;
}

async function sendLog(payload) {
  try {
    const channel = await client.channels.fetch(LOG_CHANNEL_ID);
    // Master switch (>>settings): when off, stay silent in the log channel.
    // Everything is still archived to the DB — only the channel post is skipped.
    const settings = await db.getGuildSettings();
    if (!settings.log_to_channel) return;
    await channel.send(payload);
  } catch (err) {
    console.error('[log] failed to send to log channel:', err.message);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Discord's delete event never says who deleted. The audit log does — but a
// mod's repeated deletes of the same user/channel just bump a counter on one
// entry, so we track per-entry counts to catch increments. No entry at all
// means the author deleted their own message (self-deletes aren't audited).
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
    // The audit entry can lag the gateway event slightly.
    await sleep(1200);
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
    return null; // no matching entry → self-delete
  } catch (err) {
    console.error('[audit] fetch failed (missing View Audit Log permission?):', err.message);
    return undefined;
  }
}

function shouldTrack(message) {
  if (!message.guildId) return false; // ignore DMs
  if (message.channelId === LOG_CHANNEL_ID) return false; // avoid feedback loops
  if (isIgnoredMessage(message)) return false; // IGNORE_CHANNELS opt-out
  if (message.author?.id === client.user.id) return false;
  if (IGNORE_BOTS && message.author?.bot) return false;
  return true;
}

const PREFIX = 'c!';
const NICK_PREFIX = '>>';
const MEMBER_LIST_CAP = 200;

// A member's role ids minus @everyone (whose id equals the guild id), sorted so
// two states compare equal regardless of order.
function memberRoleIds(member) {
  return [...member.roles.cache.keys()].filter((id) => id !== member.guild.id).sort();
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

  // role.members only reflects the member cache; fetch everyone first.
  await message.guild.members.fetch();
  const withRole = role.members;
  const listed = [...withRole.values()].slice(0, MEMBER_LIST_CAP);
  const lines = listed.map((m) => `<@${m.id}> \`${m.id}\``);

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

  // A single icon in the author line — matching the reference card. No thumbnail
  // or full-size image (those produced the extra copies of the spinning icon).
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

async function handleCommand(message) {
  const [cmd, ...args] = message.content.slice(PREFIX.length).trim().split(/\s+/);
  try {
    if (cmd.toLowerCase() === 'members') await handleMembersCommand(message, args);
  } catch (err) {
    console.error(`[command] ${cmd} error:`, err.message);
  }
}

// Serialize member-change handling per member. Discord fires a separate
// guildMemberUpdate for each role change, so a burst (onboarding flows assign
// several roles back-to-back) can have two handlers in flight diffing against
// the same stale baseline — double-recording the earlier change. Chaining them
// per member makes each diff see the previous one's saved state.
const memberChangeQueues = new Map();
function queueMemberChange(key, fn) {
  const prev = memberChangeQueues.get(key) ?? Promise.resolve();
  const run = prev.then(fn); // prev never rejects (entry swallows below)
  const entry = run.then(() => {}, () => {}).finally(() => {
    if (memberChangeQueues.get(key) === entry) memberChangeQueues.delete(key);
  });
  memberChangeQueues.set(key, entry);
  return run; // caller awaits this one and handles any rejection
}

// Detects nickname and role changes by diffing the incoming member against the
// last state we stored, then persists the diff and the new baseline. With no
// prior baseline (a member we've never recorded) we just seed it — we can't
// know what changed, so we wait for the next change to log it.
async function trackMemberChanges(member) {
  const { guild } = member;
  const tag = member.user.tag;
  const nickname = member.nickname ?? null;
  const roleIds = memberRoleIds(member);

  const state = await db.getMemberState(member.id);
  if (!state) {
    await db.seedMemberState(member.id, tag, nickname, roleIds);
    return;
  }

  // Nickname changes are always logged; role changes only when enabled. Either
  // way the DB record is written so >>nicknames / >>roles history stays complete.
  if ((state.nickname ?? null) !== nickname) {
    await db.recordNickname(member.id, tag, nickname);
    await sendLog({ embeds: [nicknameEmbed(member, state.nickname ?? null, nickname)] });
  }

  const before = new Set(state.role_ids ?? []);
  const after = new Set(roleIds);
  const added = [...after].filter((id) => !before.has(id));
  const removed = [...before].filter((id) => !after.has(id));
  for (const id of added) {
    await db.recordRoleChange(member.id, tag, id, guild.roles.cache.get(id)?.name ?? null, 'add');
  }
  for (const id of removed) {
    await db.recordRoleChange(member.id, tag, id, guild.roles.cache.get(id)?.name ?? null, 'remove');
  }
  if ((added.length || removed.length) && (await db.getGuildSettings()).log_role_changes) {
    await sendLog({ embeds: [roleEmbed(member, added, removed)] });
  }

  await db.setMemberState(member.id, tag, nickname, roleIds);
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

// Embed helpers for member/name changes. Mentions inside an embed never ping,
// so these are safe to post without allowedMentions.
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

function roleEmbed(member, added, removed) {
  const embed = new EmbedBuilder()
    .setColor(0x9b59b6)
    .setTitle('Roles updated')
    .setThumbnail(member.user.displayAvatarURL())
    .setDescription(memberHeader(member.user))
    .setTimestamp();
  if (added.length)
    embed.addFields({ name: '➕ Added', value: truncate(added.map((id) => `<@&${id}>`).join(', '), 1024) });
  if (removed.length)
    embed.addFields({ name: '➖ Removed', value: truncate(removed.map((id) => `<@&${id}>`).join(', '), 1024) });
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

// Detect account-level name changes — username and display name — which arrive
// via userUpdate, not guildMemberUpdate. Diffed against stored user_state so a
// restart never misses one (same reason member_state exists). Always logged.
async function trackUserNameChanges(user) {
  const state = await db.getUserState(user.id);
  const newUsername = user.username ?? null;
  const newGlobal = user.globalName ?? null;

  if (!state) {
    await db.seedUserState(user.id, newUsername, newGlobal);
    return;
  }

  const oldUsername = state.username ?? null;
  const oldGlobal = state.global_name ?? null;
  const usernameChanged = oldUsername !== newUsername;
  const globalChanged = oldGlobal !== newGlobal;
  if (!usernameChanged && !globalChanged) return;

  // userUpdate is account-global; log it under each guild we share with the user
  // (this bot is effectively single-guild, so that's normally just one).
  for (const guild of client.guilds.cache.values()) {
    if (!guild.members.cache.has(user.id)) continue;
    if (usernameChanged)
      await db.recordNameChange(user.id, user.tag, 'username', oldUsername, newUsername);
    if (globalChanged)
      await db.recordNameChange(user.id, user.tag, 'global_name', oldGlobal, newGlobal);
    await sendLog({
      embeds: [
        profileNameEmbed(user, { usernameChanged, oldUsername, newUsername, globalChanged, oldGlobal, newGlobal }),
      ],
    });
  }

  await db.setUserState(user.id, newUsername, newGlobal);
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

  await message.guild.members.fetch();
  const member = message.guild.members.cache.find(
    (m) =>
      m.user.username.toLowerCase() === q.toLowerCase() ||
      (m.nickname && m.nickname.toLowerCase() === q.toLowerCase())
  );
  return member?.user ?? null;
}

// Join lines into an embed-description-safe block (Discord caps at 4096),
// dropping the oldest and noting how many were hidden.
function fitLines(lines, budget = 3800) {
  let out = [];
  let len = 0;
  let dropped = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (len + lines[i].length + 1 > budget) {
      dropped = i + 1;
      break;
    }
    out.unshift(lines[i]);
    len += lines[i].length + 1;
  }
  if (dropped) out.unshift(`*…${dropped} older entries not shown*`);
  return out.join('\n');
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
    if (c === 'nicknames' || c === 'nicks' || c === 'nick') await handleNicknamesCommand(message, args);
    else if (c === 'roles' || c === 'role') await handleRolesCommand(message, args);
    else if (c === 'settings' || c === 'config') await handleSettingsCommand(message);
    else if (c === 'failsafe' || c === 'jarvis' || c === 'status') await handleFailsafeCommand(message);
    else if (c === 'help' || c === '')
      await message.reply(
        'Commands: `>>nicknames @user`, `>>roles @user`, `>>settings` (owner), `>>failsafe` (owner)'
      );
  } catch (err) {
    console.error(`[nick-command] ${cmd} error:`, err.message);
  }
}

client.on('messageCreate', async (message) => {
  if (message.guildId && !message.author.bot) {
    if (message.content.startsWith(PREFIX)) await handleCommand(message);
    else if (message.content.startsWith(NICK_PREFIX)) await handleNickPrefixCommand(message);
  }
  if (!shouldTrack(message)) return;
  if (LOGGING_ENABLED) {
    try {
      await db.upsertMessage(message);
    } catch (err) {
      console.error('[create] db error:', err.message);
    }
  }
  // Advert failsafe runs after archiving so its cooldown/duplicate queries see
  // prior posts. It self-gates: no-ops unless YAGPDB is offline and this is a
  // configured advert channel.
  try {
    await advertFailsafe.handleAdvert(message, sendLog);
  } catch (err) {
    console.error('[advert-failsafe] error:', err.message);
  }
  // Onboarding failsafe: age verification in the age channel. Self-gates on
  // YAGPDB being offline and the channel/member matching.
  try {
    await onboardingFailsafe.handleAgeMessage(message, sendLog);
  } catch (err) {
    console.error('[onboarding-failsafe] error:', err.message);
  }
});

client.on('messageUpdate', async (_oldMessage, newMessage) => {
  if (!LOGGING_ENABLED) return;
  try {
    if (newMessage.partial) newMessage = await newMessage.fetch();
  } catch {
    return; // message was deleted before we could fetch it
  }
  if (!shouldTrack(newMessage)) return;

  // Discord fires messageUpdate for pins, embed loads, flag changes, etc.
  // Real content edits always set editedTimestamp; the rest never do.
  if (!newMessage.editedTimestamp) return;

  try {
    const stored = await db.getMessage(newMessage.id);
    const oldContent = stored?.content ?? null;

    // Already logged this edit (e.g. a later embed-load event re-fired update).
    if (oldContent !== null && oldContent === newMessage.content) return;

    const beforeText = oldContent !== null
      ? (oldContent || '*(no text content)*')
      : '*(original not archived — sent before this bot came online)*';
    const afterText = newMessage.content || '*(no text content)*';

    const meta =
      `**Author:** ${newMessage.author} (\`${newMessage.author.tag}\`)\n` +
      `**Channel:** ${newMessage.channel} — [jump to message](${newMessage.url})\n` +
      `**Originally sent:** <t:${Math.floor(newMessage.createdTimestamp / 1000)}:f>`;

    // Everything in the description that isn't a before/after body: the metadata
    // block, the section labels, and the blank-line separators. Its exact length
    // is what's left over for the two bodies to share.
    const scaffold = `${meta}\n\n**Before:**\n\n\n**After:**\n`;
    const [before, after] = splitTruncate(beforeText, afterText, DESC_MAX - scaffold.length);

    const embed = new EmbedBuilder()
      .setColor(0xf5a623)
      .setTitle('Message edited')
      .setDescription(`${meta}\n\n**Before:**\n${before}\n\n**After:**\n${after}`)
      .setFooter({ text: `Message ID: ${newMessage.id}` })
      .setTimestamp();

    await sendLog({ embeds: [embed] });
    jsonArchive.append(newMessage.guildId, newMessage.channelId, newMessage.channel?.name, {
      type: 'edit',
      id: newMessage.id,
      authorTag: newMessage.author.tag,
      before: oldContent,
      after: newMessage.content ?? '',
      at: new Date().toISOString(),
    });

    if (stored) {
      await db.updateContent(newMessage.id, newMessage.content ?? '', new Date());
    } else {
      await db.upsertMessage(newMessage);
    }
  } catch (err) {
    console.error('[update] error:', err.message);
  }
});

client.on('messageDelete', async (message) => {
  // Consume our own suppression marker first — before the LOGGING_ENABLED
  // guard, so the set is drained even when logging is off (otherwise it
  // leaks). It means "the advert failsafe deleted this itself and already
  // logged it", so skip the per-message embed.
  if (advertFailsafe.consumeSuppressedDelete(message.id)) return;
  if (!LOGGING_ENABLED) return;
  if (message.guildId && message.channelId === LOG_CHANNEL_ID) return;
  // Honour IGNORE_BOTS by the *post's author*, not the deleter: a bot's post
  // was never archived, so don't log its deletion. A human's post is still
  // logged even when a bot deletes it (the deleter is resolved separately from
  // the audit log). Only decidable for cached (non-partial) messages — an
  // uncached bot post has no author to test, but it also has no stored row.
  if (IGNORE_BOTS && message.author?.bot) return;
  try {
    const stored = await db.getMessage(message.id);
    if (!stored && !message.guildId) return; // uncached DM, nothing to report

    const authorLine = stored
      ? `<@${stored.author_id}> (\`${stored.author_tag}\`)`
      : message.author
        ? `${message.author} (\`${message.author.tag}\`)`
        : '*unknown (not archived)*';
    const content = stored ? stored.content : message.content;
    // Attachments aren't archived to the DB anymore, so we can only list them
    // when the deleted message is still cached (non-partial); otherwise none.
    const attachments = message.attachments
      ? [...message.attachments.values()].map((a) => ({ name: a.name, url: a.url }))
      : [];
    const createdAt = stored?.created_at ?? message.createdAt;

    if (stored?.author_id === client.user.id) return;

    const authorId = stored?.author_id ?? message.author?.id ?? null;
    const executor = await findDeleteExecutor(message.guild, authorId, message.channelId);
    const deletedBy =
      executor ? `${executor} (\`${executor.tag}\`)`
      : executor === null ? 'the author (self-delete)'
      : '*unknown*';

    // A stored row or a still-cached (non-partial) message means we know the
    // real content, even if it was empty (attachment-only messages).
    const contentText = stored || !message.partial
      ? (content || '*(no text content)*')
      : '*(content not archived — sent before this bot came online)*';

    const meta =
      `**Author:** ${authorLine}\n` +
      `**Deleted by:** ${deletedBy}\n` +
      `**Channel:** <#${stored?.channel_id ?? message.channelId}>\n` +
      (createdAt ? `**Originally sent:** <t:${Math.floor(new Date(createdAt).getTime() / 1000)}:f>` : '');

    const scaffold = `${meta}\n\n**Content:**\n`;
    const body = truncate(contentText, DESC_MAX - scaffold.length);

    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle('Message deleted')
      .setDescription(`${meta}\n\n**Content:**\n${body}`)
      .setFooter({ text: `Message ID: ${message.id}` })
      .setTimestamp();

    const files = attachmentList(attachments);
    if (files) embed.addFields({ name: 'Attachments', value: files });

    await sendLog({ embeds: [embed] });
    jsonArchive.append(message.guildId, stored?.channel_id ?? message.channelId, message.channel?.name, {
      type: 'delete',
      id: message.id,
      authorTag: stored?.author_tag ?? message.author?.tag ?? null,
      deletedBy: executor?.tag ?? (executor === null ? 'self' : null),
      content: stored ? stored.content : message.content ?? null,
      at: new Date().toISOString(),
    });
    if (stored) await db.markDeleted(message.id);
  } catch (err) {
    console.error('[delete] error:', err.message);
  }
});

client.on('messageDeleteBulk', async (messages) => {
  if (!LOGGING_ENABLED) return;
  if (messages.first()?.channelId === LOG_CHANNEL_ID) return;
  if (isIgnoredMessage(messages.first() ?? {})) return; // IGNORE_CHANNELS opt-out
  const ids = [...messages.keys()];
  try {
    const stored = await db.getMessages(ids);
    const byId = new Map(stored.map((r) => [r.id, r]));

    const lines = ids.map((id) => {
      const r = byId.get(id);
      if (!r) return `[${id}] (not archived)`;
      const when = r.created_at ? new Date(r.created_at).toISOString() : 'unknown time';
      return `[${when}] ${r.author_tag ?? r.author_id}: ${r.content || '(no text content)'}`;
    });

    const channelId = stored[0]?.channel_id ?? messages.first()?.channelId;

    // Bulk deletes (purges) get their own audit type; the entry is always
    // fresh since counts aren't batched across channels the same way.
    let purgedBy = '*unknown*';
    try {
      await sleep(1200);
      const guild = messages.first()?.guild;
      const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MessageBulkDelete, limit: 5 });
      const entry = logs.entries.find(
        (e) => e.targetId === channelId && Date.now() - e.createdTimestamp < 10_000
      );
      if (entry?.executor) purgedBy = `${entry.executor} (\`${entry.executor.tag}\`)`;
    } catch (err) {
      console.error('[audit] bulk fetch failed:', err.message);
    }

    const transcript = new AttachmentBuilder(Buffer.from(lines.join('\n'), 'utf8'), {
      name: `bulk-delete-${Date.now()}.txt`,
    });
    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle('Bulk message delete')
      .setDescription(
        `**${ids.length}** messages deleted in <#${channelId}> by ${purgedBy}. Full transcript attached.`
      )
      .setTimestamp();

    await sendLog({ embeds: [embed], files: [transcript] });
    const first = messages.first();
    for (const id of ids) {
      const r = byId.get(id);
      jsonArchive.append(first?.guildId, r?.channel_id ?? first?.channelId, first?.channel?.name, {
        type: 'delete',
        id,
        bulk: true,
        authorTag: r?.author_tag ?? null,
        content: r?.content ?? null,
        at: new Date().toISOString(),
      });
    }
    await db.markDeleted(ids);
  } catch (err) {
    console.error('[bulk-delete] error:', err.message);
  }
});

// Onboarding failsafe: reacting to the server-rules message agrees to the rules
// and (while YAGPDB is offline) advances Rules Please -> Newbie. Self-gates on
// the message id, emoji, and YAGPDB status.
client.on(Events.MessageReactionAdd, async (reaction, user) => {
  try {
    await onboardingFailsafe.handleRulesReaction(reaction, user, sendLog);
  } catch (err) {
    console.error('[onboarding-failsafe] reaction error:', err.message);
  }
});

// Seed a baseline for brand-new members so their first nickname/role change is
// captured (trackMemberChanges only logs once a baseline exists).
client.on(Events.GuildMemberAdd, async (member) => {
  if (LOGGING_ENABLED) {
    try {
      await db.seedMemberState(
        member.id, member.user.tag, member.nickname ?? null, memberRoleIds(member)
      );
      await db.seedUserState(member.id, member.user.username, member.user.globalName ?? null);
    } catch (err) {
      console.error('[member-add] db error:', err.message);
    }
  }
  // Failsafe: while YAGPDB is offline, take over its join automation. Kept in a
  // separate try so a DB hiccup above never blocks it (and vice versa).
  try {
    await failsafe.handleMemberJoin(member, sendLog);
  } catch (err) {
    console.error('[member-add] failsafe error:', err.message);
  }
});

client.on(Events.GuildMemberUpdate, async (_oldMember, newMember) => {
  if (!LOGGING_ENABLED) return;
  try {
    if (newMember.partial) newMember = await newMember.fetch();
  } catch {
    return; // member left before we could fetch
  }
  try {
    const member = newMember;
    await queueMemberChange(`${member.guild.id}:${member.id}`, () => trackMemberChanges(member));
  } catch (err) {
    console.error('[member-update] error:', err.message);
  }
});

client.on(Events.UserUpdate, async (_oldUser, newUser) => {
  if (!LOGGING_ENABLED) return;
  try {
    await trackUserNameChanges(newUser);
  } catch (err) {
    console.error('[user-update] error:', err.message);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isButton() || !interaction.customId.startsWith('settings:toggle:')) return;
    if (!interaction.guild || interaction.user.id !== interaction.guild.ownerId) {
      await interaction.reply({
        content: 'Only the server owner can change these settings.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    // Flip the one toggled field, keep the rest, and re-render in place.
    // customId is settings:toggle:channel (master switch) or settings:toggle:role.
    const current = await db.getGuildSettings();
    const field = interaction.customId.endsWith(':channel') ? 'log_to_channel' : 'log_role_changes';
    const next = {
      log_role_changes: current.log_role_changes,
      log_to_channel: current.log_to_channel,
      [field]: !current[field],
    };
    await db.setGuildSettings(next);
    await interaction.update(buildSettingsMessage(next));
  } catch (err) {
    console.error('[interaction] error:', err.message);
  }
});

// Game interactions (slash commands + its buttons/menus). Self-gates and
// self-catches, so it's a no-op for non-game interactions or when disabled.
client.on(Events.InteractionCreate, (interaction) => {
  if (game.ENABLED) game.handleInteraction(interaction);
});

// Anonymous poll interactions. Self-gates on /poll, /closepoll, and poll button
// custom IDs.
client.on(Events.InteractionCreate, (interaction) => {
  if (polls.ENABLED) polls.handleInteraction(interaction);
});

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}.`);
  const slashCommands = [];
  if (game.ENABLED) slashCommands.push(...game.commandData());
  if (polls.ENABLED) slashCommands.push(...polls.commandData());
  if (slashCommands.length) {
    for (const guild of client.guilds.cache.values()) {
      try {
        await client.application.commands.set(slashCommands, guild.id);
        console.log(`[commands] registered ${slashCommands.length} command(s) in ${guild.name}`);
      } catch (err) {
        console.error(`[commands] registration failed for ${guild.name}:`, err.message);
      }
    }
  }
  if (polls.ENABLED) await polls.start(client);

  // Prime member state so nickname/role changes after startup are detected even
  // for members who never triggered an event. The fetch also populates the cache
  // the failsafe needs; the DB seeding only matters when logging is on.
  if (needMessageIntents) {
    for (const guild of client.guilds.cache.values()) {
      try {
        const members = await guild.members.fetch();
        if (LOGGING_ENABLED) {
          for (const member of members.values()) {
            await db.seedMemberState(
              member.id, member.user.tag, member.nickname ?? null, memberRoleIds(member)
            );
            await db.seedUserState(member.id, member.user.username, member.user.globalName ?? null);
          }
        }
        console.log(`[seed] members primed for ${guild.name} (${members.size})`);
      } catch (err) {
        console.warn(`[seed] could not prime members for ${guild.name}:`, err.message);
      }
    }
  }
  // Prime audit counters so deletes right after a restart aren't misread as
  // self-deletes when a mod's existing audit entry gets incremented.
  if (LOGGING_ENABLED) {
    for (const guild of client.guilds.cache.values()) {
      try {
        const logs = await guild.fetchAuditLogs({ type: AuditLogEvent.MessageDelete, limit: 50 });
        for (const entry of logs.entries.values()) {
          rememberAuditCount(entry.id, entry.extra?.count ?? 1);
        }
      } catch (err) {
        console.warn(`[audit] could not prime counts for ${guild.name}:`, err.message);
      }
    }
  }

  // Report failsafe/YAGPDB detection so a misconfigured match is obvious at boot.
  if (failsafe.ENABLED) {
    for (const guild of client.guilds.cache.values()) {
      const s = failsafe.describeStatus(guild);
      const names = s.found.map((m) => `${m.user.username}=${failsafe.statusLabel(m)}`).join(', ') || 'none';
      console.log(
        `[failsafe] ${guild.name}: ${s.found.length} YAGPDB bot(s) [${names}] → ` +
        `${s.active ? 'ACTIVE (YAGPDB offline)' : 'standby (YAGPDB online)'}`
      );
      if (s.found.length === 0) {
        console.warn(`[failsafe] no YAGPDB match in ${guild.name} — it would treat YAGPDB as offline.`);
      }
    }
    if (advertFailsafe.configured) {
      console.log(`[failsafe] advert failsafe armed for ${advertFailsafe.channelCount} channel(s).`);
      if (!LOGGING_ENABLED) {
        console.warn(
          '[failsafe] LOGGING_ENABLED=false — new adverts are not archived, so the advert ' +
          "failsafe's cooldown/duplicate checks have nothing to compare against " +
          '(length and advisory checks still work).'
        );
      }
    } else {
      console.log('[failsafe] advert failsafe inactive — no channel IDs set in src/advertConfig.js.');
    }
    if (onboardingFailsafe.configured) {
      console.log(`[failsafe] onboarding failsafe armed for age channel ${onboardingFailsafe.channelId}.`);
    } else {
      console.log('[failsafe] onboarding failsafe inactive — set AGE_VERIFY_CHANNEL_ID to enable.');
    }
    // Keep each guild's "last seen online" stamp fresh so the advert failsafe's
    // sustained-outage guard measures real downtime (not just time since boot).
    for (const guild of client.guilds.cache.values()) failsafe.markYagpdbSeen(guild);
    const tick = setInterval(() => {
      for (const guild of client.guilds.cache.values()) failsafe.markYagpdbSeen(guild);
    }, 20000);
    tick.unref?.();
  } else {
    console.log('[failsafe] disabled (FAILSAFE_ENABLED=false); GuildPresences intent not requested.');
  }

  // Retention prune: trims the DB archive so storage stays bounded. Advert
  // channels are pruned after their retention window, every other channel after
  // a longer one. Never touches Discord — it only deletes local database rows.
  // Disable with DB_RETENTION_ENABLED=false.
  if (retention.ENABLED) {
    console.log(
      `[retention] armed — adverts pruned after ${retention.advertRetentionDays}d, ` +
      `other channels after ${retention.otherRetentionDays}d; daily. (DB rows only.)`
    );
    retention.schedule();
  } else {
    console.log('[retention] disabled (DB_RETENTION_ENABLED=false).');
  }

  // Dead-link sweep: once a day (in-process, since hosts like Wispbyte only run
  // `npm start` and offer no cron). Dormant unless LINK_CHECK_CHANNELS is set;
  // `npm run check-links` still runs it manually on demand.
  linkCheck.scheduleLinkCheck(client);
});

client.on('error', (err) => console.error('[client] error:', err.message));
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));
// Last-resort backstop: a synchronous throw in a timer/callback (retention,
// failsafe tick, link-check) would otherwise crash the process and stop logging.
// Log and stay alive — this bot is stateless per-event and the pg Pool self-heals.
process.on('uncaughtException', (err) => console.error('[uncaught]', err));

db.init()
  .then(() => (game.ENABLED ? game.init() : null))
  .then(() => (polls.ENABLED ? polls.init() : null))
  .then(() => client.login(TOKEN))
  .catch((err) => {
    console.error('Startup failed:', err);
    process.exit(1);
  });
