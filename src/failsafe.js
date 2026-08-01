// Failsafe features that activate only while the YAGPDB bot ("Jarvis") is
// offline. YAGPDB is the source of truth for the server's automation; this bot
// only fills in during an outage. As long as ONE YAGPDB instance is online,
// every action in here no-ops.
//
// Knowing whether YAGPDB is online requires the privileged GuildPresences
// intent — there is no other way to observe another bot's status. The whole
// failsafe (and that intent) can therefore be switched off with
// FAILSAFE_ENABLED=false, which lets the bot boot even if the intent isn't
// enabled in the Developer Portal.
const { EmbedBuilder } = require('discord.js');

const ENABLED = process.env.FAILSAFE_ENABLED !== 'false';

// Role given to members on join while YAGPDB is down. Defaults to RPC's
// "Age Please" gate role.
const AGE_PLEASE_ROLE_ID = process.env.AGE_PLEASE_ROLE_ID || '735544386678554738';

// Optional comma-separated known YAGPDB bot user IDs. User IDs never change, so
// pinning them is the most reliable match; the username heuristic below is the
// fallback when none are pinned.
const PINNED_IDS = new Set(
  (process.env.YAGPDB_BOT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean)
);

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

// Assign the Age Please role on join — but only while YAGPDB is offline.
// `sendLog` is index.js's log-channel sender, passed in to avoid a circular
// require. Role adds are idempotent, so a brief overlap with a reconnecting
// YAGPDB is harmless.
async function handleMemberJoin(member, sendLog) {
  if (!ENABLED) return;
  if (member.user.bot) return; // gate roles are for people, not bots
  const { guild } = member;
  if (isYagpdbOnline(guild)) return; // YAGPDB is up; it owns the join flow.

  const role = guild.roles.cache.get(AGE_PLEASE_ROLE_ID);
  if (!role) {
    console.error(`[failsafe] Age Please role ${AGE_PLEASE_ROLE_ID} not found in ${guild.name}`);
    return;
  }
  if (member.roles.cache.has(role.id)) return;

  try {
    await member.roles.add(role, 'Failsafe: YAGPDB offline — Age Please on join');
    console.log(`[failsafe] assigned Age Please to ${member.user.tag} (YAGPDB offline)`);
    if (sendLog) {
      const embed = new EmbedBuilder()
        .setColor(0xe67e22)
        .setTitle('⚠️ Failsafe: Age Please assigned')
        .setDescription(
          'YAGPDB appears to be **offline**, so I assigned the failsafe join role.\n\n' +
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
