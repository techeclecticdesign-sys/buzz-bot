// Persist age-channel declarations independently of the general archive and
// onboarding failsafe. Latest valid declaration wins, including during backfill.
if (require.main === module) require('dotenv').config();
const db = require('./db');
const { memberRoleIds, queueMemberChange } = require('./memberTracking');
const CHANNEL_ID = (process.env.AGE_VERIFY_CHANNEL_ID || '735579435000004747').trim();
const ENABLED = require('./config').bool('MEMBER_AGES_ENABLED', true);

function parseAge(content) {
  if (typeof content !== 'string' || !/^\d{2}$/.test(content.trim())) return null;
  const age = Number(content.trim());
  return age >= 15 ? age : null;
}

function create({ store = db, channelId = CHANNEL_ID, enabled = ENABLED } = {}) {
  const departed = new Set();
  const key = (member) => `${member.guild.id}:${member.id}`;

  function onJoin(member) {
    departed.delete(key(member));
  }

  function onLeave(member) {
    departed.add(key(member)); // synchronous, so an in-flight scan sees it
    return queueMemberChange(key(member), () => store.deleteMemberState(member.id));
  }

  async function save(message, member, { seed = false } = {}) {
    const age = parseAge(message.content);
    if (age === null || message.author?.bot || !member || member.user?.bot) return false;
    return queueMemberChange(key(member), async () => {
      if (departed.has(key(member))) return false;
      if (seed) await store.seedMemberState(member.id, member.user.tag, member.nickname ?? null,
        memberRoleIds(member), member.displayName ?? null);
      return !!(await store.setMemberAge(member.id, age, message.createdAt, message.id));
    });
  }

  async function onMessage(message) {
    if (!enabled || message.channelId !== channelId || !message.guild || message.author?.bot
        || parseAge(message.content) === null) return false;
    // Force a current membership check; do not trust a cached departed member.
    let member;
    try {
      member = await message.guild.members.fetch({ user: message.author.id, force: true });
    } catch (err) {
      if (err.status === 404 || err.code === 10007) return false;
      throw err;
    }
    return save(message, member, { seed: true });
  }

  async function backfill(client) {
    if (!enabled) return { scanned: 0, members: 0, saved: 0 };
    const channel = await client.channels.fetch(channelId);
    if (!channel?.guild || !channel.messages) throw new Error('age channel is not a guild text channel');
    console.log('[member-ages] fetching current members and scanning age-channel history');
    // No pruning or writes if the full member fetch fails.
    const members = await channel.guild.members.fetch();
    if (!members.size) throw new Error('full member list is empty; age backfill skipped');
    if (client.guilds.cache.size === 1) await store.pruneDepartedMemberState([...members.keys()]);
    const seen = new Set();
    let before;
    let scanned = 0;
    let saved = 0;
    for (;;) {
      const messages = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
      if (!messages.size) break;
      // API pages are newest first, but sort explicitly for predictable selection.
      const ordered = [...messages.values()].sort((a, b) => a.id === b.id ? 0 : BigInt(a.id) > BigInt(b.id) ? -1 : 1);
      const pending = [];
      for (const message of ordered) {
        scanned++;
        const id = message.author?.id;
        if (!members.has(id) || seen.has(id) || message.author.bot || parseAge(message.content) === null) continue;
        seen.add(id);
        pending.push({ message, member: members.get(id) });
      }
      // Hold the same per-member queues as live updates and departure cleanup.
      // Sorted acquisition avoids deadlock between concurrent backfills.
      pending.sort((a, b) => key(a.member).localeCompare(key(b.member)));
      const locked = (i) => i < pending.length
        ? queueMemberChange(key(pending[i].member), () => locked(i + 1))
        : store.setMemberAges(pending.filter(({ member }) => !departed.has(key(member))).map(({ message, member }) => ({
          user_id: member.id, user_tag: member.user.tag, nickname: member.nickname ?? null,
          display_name: member.displayName ?? null, role_ids: memberRoleIds(member),
          age_stated: parseAge(message.content), age_stated_at: message.createdAt, age_message_id: message.id,
        })));
      if (pending.length) saved += await locked(0);
      const next = ordered.at(-1).id;
      if (next === before) throw new Error('age history pagination did not advance');
      before = next;
      if (scanned % 1000 === 0) console.log(`[member-ages] scanned ${scanned} messages, saved ${saved} member age(s)`);
    }
    console.log(`[member-ages] backfill complete: ${scanned} messages, ${seen.size} current members with ages, ${saved} saved`);
    return { scanned, members: seen.size, saved };
  }

  return { onJoin, onLeave, onMessage, backfill };
}

if (require.main === module) {
  const { Client, Events, GatewayIntentBits } = require('discord.js');
  const { initMemberAges } = require('./db/memberAgesSchema');
  const tracker = create({ enabled: true });
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  client.on(Events.GuildMemberRemove, (member) => tracker.onLeave(member).catch((err) => console.error('[member-ages]', err.message)));
  client.on(Events.GuildMemberAdd, (member) => tracker.onJoin(member));
  client.once(Events.ClientReady, async () => {
    try {
      await initMemberAges((sql) => db.pool.query(sql));
      await tracker.backfill(client);
    } catch (err) {
      console.error('[member-ages] backfill failed:', err.message);
      process.exitCode = 1;
    } finally {
      client.destroy();
      await db.pool.end();
    }
  });
  client.login(process.env.DISCORD_TOKEN).catch(async () => {
    console.error('[member-ages] Discord login failed');
    client.destroy();
    await db.pool.end();
    process.exitCode = 1;
  });
}

module.exports = { CHANNEL_ID, ENABLED, parseAge, create };
