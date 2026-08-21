// Features that act only while YAGPDB ("Jarvis") is offline; while any YAGPDB
// instance is online, everything here no-ops. Detecting that needs the privileged
// GuildPresences intent, so the whole failsafe can be disabled with
// FAILSAFE_ENABLED=false (lets the bot boot without the intent).
const { EmbedBuilder } = require('discord.js');
const config = require('./config');

const ENABLED = config.bool('FAILSAFE_ENABLED', true);

// Role given to members on join while YAGPDB is down. Defaults to RPC's
// "Age Please" gate role.
const AGE_PLEASE_ROLE_ID = process.env.AGE_PLEASE_ROLE_ID || '735544386678554738';

// Optional comma-separated known YAGPDB bot user IDs. User IDs never change, so
// pinning them is the most reliable match; the username heuristic below is the
// fallback when none are pinned.
const PINNED_IDS = new Set(config.idList('YAGPDB_BOT_IDS'));

// Lowercase and drop everything but letters/digits so punctuation and the
// #discriminator (which can change) don't matter: "YAGPDB.xyz#8760" → "yagpdbxyz".
const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

// A member counts as a YAGPDB instance if its user id is pinned, or if it's a
// bot whose username/display name contains "yagpdb". Requiring the bot flag is
// deliberate: a human can rename themselves "yagpdb" but can't fake the bot
// badge, so impersonators can't trick the failsafe into standing down.
function isYagpdb(member) {
  const user = member.user;
  if (!user) return false;
  if (PINNED_IDS.has(user.id)) return true;
  if (!user.bot) return false;
  return norm(user.username).includes('yagpdb') || norm(user.globalName).includes('yagpdb');
}

// Online = a presence exists whose status isn't "offline". Needs GuildPresences;
// without it presence is null and YAGPDB always reads as offline — which is why
// the join action is also gated on ENABLED (no intent → no reliable detection).
function isOnline(member) {
  const status = member.presence?.status;
  return !!status && status !== 'offline';
}

function statusLabel(member) {
  return member.presence?.status ?? 'offline';
}

function yagpdbMembers(guild) {
  return [...guild.members.cache.filter(isYagpdb).values()];
}

function isYagpdbOnline(guild) {
  return guild.members.cache.some((m) => isYagpdb(m) && isOnline(m));
}

// Last time YAGPDB was seen online per guild. Lets the destructive advert
// failsafe require a *sustained* outage rather than reacting to a momentary
// presence blip (a reconnecting YAGPDB). Refreshed by a periodic tick in
// index.js while YAGPDB is up; a benign no-op for the idempotent join task.
const lastOnlineAt = new Map();

function markYagpdbSeen(guild) {
  if (guild && isYagpdbOnline(guild)) lastOnlineAt.set(guild.id, Date.now());
}

// Milliseconds since YAGPDB was last seen online: 0 if online now, Infinity if
// it has never been seen online this session (e.g. the bot booted mid-outage).
function offlineForMs(guild) {
  if (isYagpdbOnline(guild)) return 0;
  const last = lastOnlineAt.get(guild.id);
  return last === undefined ? Infinity : Date.now() - last;
}

// Assign the Age Please role on join immediately (idempotent, so YAGPDB also
// assigning it is harmless; the cache check below skips the redundant call).
// sendLog is passed in to avoid a circular require; the embed fires only when
// YAGPDB is actually offline (normal joins get a console line, not log spam).
async function handleMemberJoin(member, sendLog) {
  if (!ENABLED) return;
  if (member.user.bot) return; // gate roles are for people, not bots
  const { guild } = member;
  const yagpdbDown = !isYagpdbOnline(guild);

  const role = guild.roles.cache.get(AGE_PLEASE_ROLE_ID);
  if (!role) {
    console.error(`[failsafe] Age Please role ${AGE_PLEASE_ROLE_ID} not found in ${guild.name}`);
    return;
  }
  if (member.roles.cache.has(role.id)) return; // already has it (e.g. YAGPDB beat us)

  try {
    const reason = yagpdbDown
      ? 'Failsafe: YAGPDB offline — Age Please on join'
      : 'Age Please on join';
    await member.roles.add(role, reason);
    console.log(
      `[failsafe] assigned Age Please to ${member.user.tag}` +
      (yagpdbDown ? ' (YAGPDB offline)' : '')
    );
    // Only surface the failsafe embed when YAGPDB is genuinely down.
    if (sendLog && yagpdbDown) {
      const embed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle('⚠️ Failsafe: Age Please assigned')
        .setDescription(
          'YAGPDB appears to be **offline**, so I assigned the join role.\n\n' +
          `**Member:** <@${member.id}> (\`${member.user.username}\`)\n` +
          `**Role:** ${role} \`${role.name}\``
        )
        .setThumbnail(member.user.displayAvatarURL())
        .setTimestamp();
      await sendLog({ embeds: [embed] });
    }
  } catch (err) {
    console.error(`[failsafe] could not assign Age Please to ${member.user.tag}:`, err.message);
    if (sendLog) {
      await sendLog({
        content:
          `⚠️ Failsafe tried to assign **Age Please** to <@${member.id}> but failed: ${err.message}. ` +
          'Check that I have **Manage Roles** and that my highest role is above **Age Please**.',
        allowedMentions: { parse: [] },
      });
    }
  }
}

// Snapshot for the >>failsafe diagnostic command.
function describeStatus(guild) {
  const found = yagpdbMembers(guild);
  const online = found.filter(isOnline);
  return {
    enabled: ENABLED,
    found,
    online,
    active: ENABLED && online.length === 0, // would act on the next join
    roleId: AGE_PLEASE_ROLE_ID,
  };
}

module.exports = {
  ENABLED,
  AGE_PLEASE_ROLE_ID,
  isYagpdb,
  isOnline,
  statusLabel,
  yagpdbMembers,
  isYagpdbOnline,
  markYagpdbSeen,
  offlineForMs,
  handleMemberJoin,
  describeStatus,
};
