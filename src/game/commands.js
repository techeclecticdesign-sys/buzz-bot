// Slash-command definitions + interaction routing for the game.
// Every handler defers first, then does DB work, then edits the reply — Neon's
// free tier can cold-start past Discord's 3s ack window, so we never rely on it.
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const data = require('./gameData');
const db = require('./db');
const logic = require('./logic');
const ui = require('./ui');

const EPHEMERAL = MessageFlags.Ephemeral;
const hospTs = (p) => Math.floor(new Date(p.hospital_until).getTime() / 1000);

// Optional public announcements (big crime scores + won attacks). Set
// GAME_ANNOUNCE_CHANNEL_ID to enable; leave unset to keep the game silent.
const ANNOUNCE_CHANNEL_ID = process.env.GAME_ANNOUNCE_CHANNEL_ID;
const ANNOUNCE_CRIME_MIN = Number(process.env.GAME_ANNOUNCE_CRIME_MIN) || 10000;
async function announce(client, text) {
  if (!ANNOUNCE_CHANNEL_ID) return;
  try {
    const ch = client.channels.cache.get(ANNOUNCE_CHANNEL_ID) ?? (await client.channels.fetch(ANNOUNCE_CHANNEL_ID));
    if (ch) await ch.send({ content: text, allowedMentions: { parse: [] } });
  } catch {
    /* channel gone or no perms — announcements are best-effort */
  }
}

// The slash commands this module owns (registered per guild on ready).
function commandData() {
  return [
    new SlashCommandBuilder().setName('mprofile').setDescription('View your rap sheet'),
    new SlashCommandBuilder().setName('crime').setDescription('Commit crimes to earn cash and XP'),
    new SlashCommandBuilder().setName('gym').setDescription('Train Strength or Defense'),
    new SlashCommandBuilder()
      .setName('hit')
      .setDescription('Attack a rival to steal their cash (once a day)')
      .addUserOption((o) => o.setName('target').setDescription('Who to attack').setRequired(true)),
    new SlashCommandBuilder().setName('shop').setDescription('Buy weapons, armor, and property'),
    new SlashCommandBuilder().setName('collect').setDescription('Collect income from your property'),
    new SlashCommandBuilder().setName('top').setDescription('Show the leaderboard'),
    new SlashCommandBuilder().setName('mhelp').setDescription('How to play'),
  ].map((c) => c.toJSON());
}

// --- /mprofile (auto-collects property income on check-in) ---
async function cmdProfile(interaction) {
  await interaction.deferReply({ flags: EPHEMERAL });
  const player = await db.withPlayer(interaction.user.id, async (client, p) => {
    logic.materialize(p);
    logic.collectProperty(p);
    await db.savePlayer(client, p);
    return p;
  });
  await interaction.editReply({ embeds: [ui.profileEmbed(player, interaction.user)] });
}

// --- /crime (opens the menu) ---
async function cmdCrime(interaction) {
  await interaction.deferReply({ flags: EPHEMERAL });
  const player = await db.withPlayer(interaction.user.id, async (client, p) => {
    logic.materialize(p);
    await db.savePlayer(client, p);
    return p;
  });
  await interaction.editReply({ embeds: [ui.crimeEmbed(player)], components: [ui.crimeMenu(player)] });
}

function crimeResultLine(crime, r, player) {
  if (r.success) {
    let line = `✅ **${crime.name}** — earned ${ui.money(r.cash)} (+${r.xp} XP)`;
    if (r.levels) line += `\n🎉 **Level up!** You're now level ${player.level}.`;
    return line;
  }
  if (r.botched) return `🚑 Botched job! **${crime.name}** went sideways — you're in the hospital until <t:${hospTs(player)}:R>.`;
  return `❌ **${crime.name}** failed — you got away, but empty-handed.`;
}

async function onCrimePick(interaction) {
  await interaction.deferUpdate();
  const crime = data.CRIMES_BY_ID[interaction.values[0]];
  const { line, player, result } = await db.withPlayer(interaction.user.id, async (client, p) => {
    logic.materialize(p);
    let line;
    let result = null;
    if (!crime || p.level < crime.unlock) line = '⚠️ That crime is locked.';
    else if (logic.isHospitalised(p)) line = `🏥 You're in the hospital until <t:${hospTs(p)}:R>.`;
    else if (logic.energyNow(p) < crime.energy) line = `⚠️ Not enough energy (need ${crime.energy}⚡).`;
    else {
      result = logic.doCrime(p, crime);
      line = crimeResultLine(crime, result, p);
    }
    await db.savePlayer(client, p);
    return { line, player: p, result };
  });
  await interaction.editReply({ embeds: [ui.crimeEmbed(player, line)], components: [ui.crimeMenu(player)] });
  if (result?.success && result.cash >= ANNOUNCE_CRIME_MIN) {
    announce(interaction.client, `🔫 <@${interaction.user.id}> pulled off **${crime.name}** for ${ui.money(result.cash)}!`);
  }
}

// --- /gym ---
async function cmdGym(interaction) {
  await interaction.deferReply({ flags: EPHEMERAL });
  const player = await db.withPlayer(interaction.user.id, async (client, p) => {
    logic.materialize(p);
    await db.savePlayer(client, p);
    return p;
  });
  await interaction.editReply({ embeds: [ui.gymEmbed(player)], components: [ui.gymComponents()] });
}

async function onGym(interaction) {
  await interaction.deferUpdate();
  const stat = interaction.customId.split(':')[2]; // 'strength' | 'defense'
  const { line, player } = await db.withPlayer(interaction.user.id, async (client, p) => {
    logic.materialize(p);
    let line;
    if (!['strength', 'defense'].includes(stat)) line = '⚠️ Unknown exercise.';
    else if (logic.isHospitalised(p)) line = `🏥 You're in the hospital until <t:${hospTs(p)}:R>.`;
    else if (logic.energyNow(p) < data.GYM.costEnergy) line = '⚠️ Not enough energy to train.';
    else {
      const r = logic.doGym(p, stat);
      line = `✅ Trained **${stat}** +${r.gain}${r.soft ? ' _(focus fading — come back tomorrow)_' : ''}.`;
    }
    await db.savePlayer(client, p);
    return { line, player: p };
  });
  await interaction.editReply({ embeds: [ui.gymEmbed(player, line)], components: [ui.gymComponents()] });
}

// --- /hit @target ---
async function cmdHit(interaction) {
  await interaction.deferReply({ flags: EPHEMERAL });
  const target = interaction.options.getUser('target');
  const me = interaction.user.id;
  if (target.id === me) return interaction.editReply("🤨 You can't hit yourself.");
  if (target.bot) return interaction.editReply("🤖 Bots don't carry cash.");
  if (!(await db.playerExists(target.id))) {
    return interaction.editReply(`**${target.username}** hasn't joined the game yet.`);
  }

  const res = await db.withTwoPlayers(me, target.id, async (client, atk, def) => {
    logic.materialize(atk);
    logic.materialize(def);
    if (logic.isHospitalised(atk)) return { line: `🏥 You're in the hospital until <t:${hospTs(atk)}:R>.` };
    const cd = logic.attackCooldownLeftMs(atk);
    if (cd > 0) return { line: `⏳ You can attack again <t:${Math.floor((Date.now() + cd) / 1000)}:R>.` };
    if (logic.isHospitalised(def)) return { line: `🛡️ **${target.username}** is in the hospital and can't be attacked right now.` };
    if (def.level < atk.level - data.COMBAT.maxLevelGapDown) {
      return { line: `🚫 You can't punch down more than ${data.COMBAT.maxLevelGapDown} levels.` };
    }
    const r = logic.resolveAttack(atk, def);
    await db.savePlayer(client, atk);
    await db.savePlayer(client, def);
    await db.logAttack(client, me, target.id, r.won, r.won ? r.steal : 0);
    if (r.won) {
      let line = `💥 You beat **${target.username}** and took ${ui.money(r.steal)}! (+${r.xp} XP, +1 ⭐)`;
      if (r.levels) line += `\n🎉 **Level up!** You're now level ${atk.level}.`;
      return { line, won: true, steal: r.steal };
    }
    return { line: `🤕 **${target.username}** got the better of you — you're hospitalised for ${data.COMBAT.hospitalHours}h.` };
  });
  await interaction.editReply(res.line);
  if (res.won) {
    announce(interaction.client, `💥 <@${me}> jumped <@${target.id}> and took ${ui.money(res.steal)}!`);
  }
}

// --- /shop ---
async function cmdShop(interaction) {
  await interaction.deferReply({ flags: EPHEMERAL });
  const player = await db.withPlayer(interaction.user.id, async (client, p) => {
    logic.materialize(p);
    await db.savePlayer(client, p);
    return p;
  });
  await interaction.editReply({ embeds: [ui.shopEmbed(player)], components: [ui.shopMenu(player)] });
}

async function onShopBuy(interaction) {
  await interaction.deferUpdate();
  const [cat, id] = interaction.values[0].split(':');
  const tables = { weapon: data.WEAPONS_BY_ID, armor: data.ARMORS_BY_ID, property: data.PROPERTIES_BY_ID };
  const { line, player } = await db.withPlayer(interaction.user.id, async (client, p) => {
    logic.materialize(p);
    const item = tables[cat]?.[id];
    const owned = (cat === 'weapon' && p.weapon_id === id) || (cat === 'armor' && p.armor_id === id) || (cat === 'property' && p.property_id === id);
    let line;
    if (!item) line = '⚠️ No such item.';
    else if (owned) line = 'You already own that.';
    else if (Number(p.cash) < item.cost) line = `⚠️ Not enough cash (need ${ui.money(item.cost)}).`;
    else {
      p.cash = Number(p.cash) - item.cost;
      line = `✅ Bought **${item.name}** for ${ui.money(item.cost)}.`;
      if (cat === 'weapon') p.weapon_id = id;
      else if (cat === 'armor') p.armor_id = id;
      else if (cat === 'property') {
        // Bank the old property's accrued income before it's replaced.
        const collected = logic.collectProperty(p);
        if (collected > 0) line += ` (Collected ${ui.money(collected)} from your old property first.)`;
        p.property_id = id;
        p.property_collected_at = new Date();
      }
    }
    await db.savePlayer(client, p);
    return { line, player: p };
  });
  await interaction.editReply({ embeds: [ui.shopEmbed(player, line)], components: [ui.shopMenu(player)] });
}

// --- /collect ---
async function cmdCollect(interaction) {
  await interaction.deferReply({ flags: EPHEMERAL });
  const { income, player } = await db.withPlayer(interaction.user.id, async (client, p) => {
    logic.materialize(p);
    const income = logic.collectProperty(p);
    await db.savePlayer(client, p);
    return { income, player: p };
  });
  let content;
  if (!player.property_id) content = "You don't own a property yet — buy one in `/shop`.";
  else if (income > 0) content = `💰 Collected ${ui.money(income)} from your ${data.PROPERTIES_BY_ID[player.property_id].name}.`;
  else content = 'Nothing to collect yet — check back later.';
  await interaction.editReply({ content, embeds: [ui.profileEmbed(player, interaction.user)] });
}

// --- /top ---
async function cmdTop(interaction) {
  await interaction.deferReply({ flags: EPHEMERAL });
  const rows = await db.top(10);
  await interaction.editReply({ embeds: [ui.topEmbed(rows, (id) => `<@${id}>`)], allowedMentions: { parse: [] } });
}

// --- /mhelp (paged manual) ---
async function cmdHelp(interaction) {
  await interaction.reply({ embeds: [ui.helpEmbed(0)], components: [ui.helpComponents(0)], flags: EPHEMERAL });
}

async function onHelpNav(interaction) {
  let i = parseInt(interaction.customId.split(':')[2], 10);
  if (!Number.isInteger(i) || i < 0 || i >= ui.HELP_PAGES.length) i = 0;
  await interaction.update({ embeds: [ui.helpEmbed(i)], components: [ui.helpComponents(i)] });
}

// Router. Returns true if this interaction was a game interaction (handled),
// false otherwise so other listeners can have it.
async function handleInteraction(interaction) {
  if (interaction.isChatInputCommand()) {
    switch (interaction.commandName) {
      case 'mprofile': await cmdProfile(interaction); return true;
      case 'crime': await cmdCrime(interaction); return true;
      case 'gym': await cmdGym(interaction); return true;
      case 'hit': await cmdHit(interaction); return true;
      case 'shop': await cmdShop(interaction); return true;
      case 'collect': await cmdCollect(interaction); return true;
      case 'top': await cmdTop(interaction); return true;
      case 'mhelp': await cmdHelp(interaction); return true;
      default: return false;
    }
  }
  if (interaction.isStringSelectMenu() && interaction.customId === 'game:crime:pick') {
    await onCrimePick(interaction);
    return true;
  }
  if (interaction.isStringSelectMenu() && interaction.customId === 'game:shop:buy') {
    await onShopBuy(interaction);
    return true;
  }
  if (interaction.isButton() && interaction.customId.startsWith('game:gym:')) {
    await onGym(interaction);
    return true;
  }
  if (interaction.isButton() && interaction.customId.startsWith('game:help:')) {
    await onHelpNav(interaction);
    return true;
  }
  return false;
}

module.exports = { commandData, handleInteraction };
