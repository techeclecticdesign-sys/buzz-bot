// Kicks members who join wearing the profile picture of a known marketer account.
// Staff add pictures with >>pfpban (an uploaded image, a Discord image link, or a
// user whose current avatar to take); joins are matched by perceptual hash, so the
// enlarged download and the avatar Discord serves the bot still match.
const { AttachmentBuilder, EmbedBuilder } = require('discord.js');
const config = require('./config');
const db = require('./db');
const { downloadImages } = require('./advertImages');
const { fitLines } = require('./format');
const { MIN_DETAIL, phash, nearest, thumbnail } = require('./pfpHash');

const ENABLED = config.bool('PFP_GUARD_ENABLED', true);
// false = post the match but leave the member in the server.
const KICK = config.bool('PFP_GUARD_KICK', true);
// Same picture re-served by Discord measures 0-6 bits; unrelated avatars 14+.
const MAX_DISTANCE = config.num('PFP_MATCH_MAX_DISTANCE', 8, { min: 0, max: 20 });
// Match reports go here; unset falls back to the log channel (sendLog).
const LOG_CHANNEL_ID = process.env.PFP_GUARD_LOG_CHANNEL_ID || '';
const MOD_ROLES = config.idList('MOD_ROLES');

const CDN_HOSTS = new Set(['cdn.discordapp.com', 'media.discordapp.net']);

async function fetchImage(url) {
  const [img] = await downloadImages([{ url }]);
  return img?.buffer ?? null;
}

function avatarUrl(user) {
  return user.avatar ? user.avatarURL({ extension: 'png', size: 512, forceStatic: true }) : null;
}

async function report(client, sendLog, payload) {
  if (LOG_CHANNEL_ID) {
    try {
      const channel = await client.channels.fetch(LOG_CHANNEL_ID);
      await channel.send({ ...payload, allowedMentions: { parse: [] } });
      return;
    } catch (err) {
      console.error('[pfp-guard] report channel failed:', err.message);
    }
  }
  await sendLog({ ...payload, allowedMentions: { parse: [] } });
}

// Returns true when the member was kicked, so later join handling can be skipped.
async function handleMemberJoin(member, sendLog) {
  if (!ENABLED || member.user.bot) return false;
  const url = avatarUrl(member.user);
  if (!url) return false; // default avatar

  const rows = await db.listMarketerPfps();
  if (rows.length === 0) return false;
  const buffer = await fetchImage(url);
  if (!buffer) {
    console.warn(`[pfp-guard] could not download avatar of ${member.user.tag}`);
    return false;
  }
  const { hash } = await phash(buffer);
  const match = nearest(hash, rows);
  if (!match || match.distance > MAX_DISTANCE) return false;

  const entry = match.row;
  let kicked = false;
  let kickError = null;
  if (KICK) {
    try {
      await member.kick(`Profile picture matches banned marketer pfp #${entry.id}`);
      kicked = true;
    } catch (err) {
      kickError = err.message;
    }
  }
  console.log(
    `[pfp-guard] ${member.user.tag} (${member.id}) matched #${entry.id} at ${match.distance} bits — ` +
    (kicked ? 'kicked' : kickError ? `kick failed: ${kickError}` : 'log only')
  );
  await db.recordMarketerPfpHit(entry.id).catch(() => {});

  const thumb = await db.getMarketerPfpThumb(entry.id).catch(() => null);
  const created = Math.floor(member.user.createdTimestamp / 1000);
  const embed = new EmbedBuilder()
    .setColor(kicked ? 0xe74c3c : 0xe67e22)
    .setTitle(kicked ? '🚫 Marketer pfp — kicked on join' : '⚠️ Marketer pfp match on join')
    .setDescription(
      `**Member:** <@${member.id}> (\`${member.user.username}\`, \`${member.id}\`)\n` +
      `**Account created:** <t:${created}:f> (<t:${created}:R>)\n` +
      `**Matched:** banned pfp #${entry.id}${entry.note ? ` — ${entry.note}` : ''}\n` +
      `**Distance:** ${match.distance}/64 bits (limit ${MAX_DISTANCE})` +
      (kickError
        ? `\n\n**Kick failed:** ${kickError}. Check that I have **Kick Members** and outrank the member.`
        : !KICK ? '\n\nNot kicked: `PFP_GUARD_KICK=false`.' : '')
    )
    .setThumbnail(url)
    .setFooter({ text: 'Thumbnail: their avatar · Image: the banned pfp' })
    .setTimestamp();
  const files = [];
  if (thumb) {
    files.push(new AttachmentBuilder(thumb, { name: 'banned-pfp.png' }));
    embed.setImage('attachment://banned-pfp.png');
  }
  await report(member.client, sendLog, { embeds: [embed], files });
  return kicked;
}

// --- Staff commands ---

function isStaff(message) {
  if (message.guild.ownerId === message.author.id) return true;
  return MOD_ROLES.length > 0 && !!message.member?.roles.cache.hasAny(...MOD_ROLES);
}

// Pictures named by a command: its attachments, Discord image links, and the
// current avatars of mentioned / id'd users. Remaining words are the note.
async function collectSources(message, args) {
  const sources = [];
  const noteWords = [];
  for (const a of message.attachments.values()) sources.push({ label: a.name, url: a.url });
  for (const arg of args) {
    const userId = arg.match(/^<@!?(\d{17,20})>$/)?.[1] ?? arg.match(/^(\d{17,20})$/)?.[1];
    if (userId) {
      const user = await message.client.users.fetch(userId, { force: true }).catch(() => null);
      sources.push({ label: user ? `@${user.username}` : userId, userId, url: user && avatarUrl(user) });
      continue;
    }
    let link = null;
    try {
      link = new URL(arg);
    } catch {}
    if (link && /^https?:$/.test(link.protocol)) {
      sources.push({ label: 'link', url: CDN_HOSTS.has(link.hostname) ? arg : null, badHost: !CDN_HOSTS.has(link.hostname) });
      continue;
    }
    noteWords.push(arg);
  }
  return { sources, note: noteWords.join(' ').slice(0, 200) || null };
}

// Download + hash one source → { hash, detail, buffer } or { error }.
async function hashSource(src) {
  if (src.badHost) return { error: 'only Discord image links (cdn.discordapp.com / media.discordapp.net) are accepted' };
  if (!src.url) return { error: src.userId ? 'user not found or has the default avatar' : 'no image' };
  const buffer = await fetchImage(src.url);
  if (!buffer) return { error: 'download failed (or over 8 MB)' };
  try {
    return { ...(await phash(buffer)), buffer };
  } catch {
    return { error: 'not a readable image' };
  }
}

const USAGE_SOURCES = 'attach the image, paste its Discord link, or give a user mention / id';

async function handleBan(message, args) {
  const { sources, note } = await collectSources(message, args);
  if (sources.length === 0) {
    await message.reply(`Usage: \`>>pfpban <image | link | @user | id> [note]\` — ${USAGE_SOURCES}.`);
    return;
  }
  const rows = await db.listMarketerPfps();
  const lines = [];
  for (const src of sources) {
    const h = await hashSource(src);
    if (h.error) {
      lines.push(`❌ ${src.label}: ${h.error}`);
      continue;
    }
    if (h.detail < MIN_DETAIL) {
      lines.push(`❌ ${src.label}: too plain to match safely (would catch unrelated plain avatars)`);
      continue;
    }
    const dupe = nearest(h.hash, rows);
    if (dupe && dupe.distance <= MAX_DISTANCE) {
      lines.push(`➖ ${src.label}: already covered by #${dupe.row.id} (${dupe.distance} bits)`);
      continue;
    }
    const id = await db.addMarketerPfp({
      phash: h.hash,
      thumb: await thumbnail(h.buffer),
      sourceUserId: src.userId,
      note,
      addedBy: message.author.id,
    });
    rows.push({ id, phash: h.hash });
    lines.push(`✅ ${src.label}: added as #${id}`);
  }
  await message.reply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
}

async function handleUnban(message, args) {
  const id = Number(args[0]);
  if (!Number.isInteger(id) || id <= 0) {
    await message.reply('Usage: `>>pfpunban <number from >>pfplist>`');
    return;
  }
  const removed = await db.deleteMarketerPfp(id);
  await message.reply(removed ? `Removed banned pfp #${id}.` : `No banned pfp #${id}.`);
}

async function handleList(message, args) {
  const rows = await db.listMarketerPfps();
  if (rows.length === 0) {
    await message.reply('No banned pfps yet. Add one with `>>pfpban`.');
    return;
  }
  // `>>pfplist 12` shows that entry's picture.
  const id = Number(args[0]);
  if (Number.isInteger(id) && id > 0) {
    const thumb = await db.getMarketerPfpThumb(id);
    if (!thumb) {
      await message.reply(`No banned pfp #${id}.`);
      return;
    }
    await message.reply({ content: `Banned pfp #${id}`, files: [new AttachmentBuilder(thumb, { name: `pfp-${id}.png` })] });
    return;
  }
  const lines = rows.map((r) => {
    const added = Math.floor(new Date(r.created_at).getTime() / 1000);
    return `**#${r.id}** ${r.note ?? '*no note*'}` +
      (r.source_user_id ? ` · from \`${r.source_user_id}\`` : '') +
      ` · added <t:${added}:d> by <@${r.added_by}> · ${r.hits} kick${r.hits === 1 ? '' : 's'}`;
  });
  const embed = new EmbedBuilder()
    .setColor(0x95a5a6)
    .setTitle(`Banned marketer pfps (${rows.length})`)
    .setDescription(fitLines(lines))
    .setFooter({
      text: `${ENABLED ? (KICK ? 'Kicking' : 'Log only') : 'Disabled'} · match ≤ ${MAX_DISTANCE} bits · >>pfplist <#> shows one`,
    });
  await message.channel.send({ embeds: [embed], allowedMentions: { parse: [] } });
}

async function handleCheck(message, args) {
  const { sources } = await collectSources(message, args);
  if (sources.length === 0) {
    await message.reply(`Usage: \`>>pfpcheck <image | link | @user | id>\` — ${USAGE_SOURCES}.`);
    return;
  }
  const rows = await db.listMarketerPfps();
  const lines = [];
  for (const src of sources) {
    const h = await hashSource(src);
    if (h.error) {
      lines.push(`❌ ${src.label}: ${h.error}`);
      continue;
    }
    const best = nearest(h.hash, rows);
    lines.push(
      !best
        ? `${src.label}: list is empty`
        : `${best.distance <= MAX_DISTANCE ? '🚫 would be kicked' : '✅ no match'} — ${src.label}: ` +
          `closest is #${best.row.id} at ${best.distance} bits (limit ${MAX_DISTANCE})`
    );
  }
  await message.reply({ content: lines.join('\n'), allowedMentions: { parse: [] } });
}

const COMMANDS = {
  pfpban: handleBan,
  pfpunban: handleUnban,
  pfplist: handleList,
  pfpcheck: handleCheck,
};

// Routes a >> command; returns false when it isn't a pfp command.
async function handleCommand(message, cmd, args) {
  const handler = COMMANDS[cmd];
  if (!handler) return false;
  if (!isStaff(message)) {
    await message.reply('Only staff can manage banned pfps.');
    return true;
  }
  await handler(message, args);
  return true;
}

module.exports = { ENABLED, KICK, MAX_DISTANCE, handleMemberJoin, handleCommand };
