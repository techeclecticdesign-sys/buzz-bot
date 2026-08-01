// Embed + component builders for the game. Kept separate from logic so the
// presentation can change without touching balance.
const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');
const data = require('./gameData');
const logic = require('./logic');

const COLOR = 0x8b0000; // dark red
const money = (n) => '$' + Number(n).toLocaleString('en-US');

// A 10-cell unicode progress bar.
function bar(cur, max, width = 10) {
  const filled = max > 0 ? Math.round((Math.min(cur, max) / max) * width) : 0;
  return '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
}

function profileEmbed(player, user) {
  const eMax = data.maxEnergy(player.level);
  const eNow = logic.energyNow(player);
  const hMax = data.maxHp(player.level);
  const hNow = Math.floor(Number(player.hp));
  const xpNext = data.xpToNext(player.level);
  const weapon = data.WEAPONS_BY_ID[player.weapon_id] ?? data.WEAPONS_BY_ID.fists;
  const armor = data.ARMORS_BY_ID[player.armor_id] ?? data.ARMORS_BY_ID.none;
  const prop = player.property_id ? data.PROPERTIES_BY_ID[player.property_id] : null;

  const lines = [
    `**Level ${player.level}**  •  ${money(player.cash)}  •  ⭐ ${player.respect} respect`,
    `⚡ Energy  \`${bar(eNow, eMax)}\` ${eNow}/${eMax}`,
    `❤️ Health  \`${bar(hNow, hMax)}\` ${hNow}/${hMax}`,
    `✨ XP      \`${bar(player.exp, xpNext)}\` ${player.exp}/${xpNext}`,
    '',
    `💪 Strength **${player.strength}**   🛡️ Defense **${player.defense}**`,
    `🔫 ${weapon.name} (×${weapon.mult})   🦺 ${armor.name} (×${armor.mult})`,
    prop ? `🏢 ${prop.name} — ${money(prop.perHour)}/hr` : '🏢 No property',
  ];
  if (logic.isHospitalised(player)) {
    lines.push(`\n🏥 **In the hospital** until <t:${Math.floor(new Date(player.hospital_until).getTime() / 1000)}:R>`);
  }

  return new EmbedBuilder()
    .setColor(COLOR)
    .setAuthor({ name: `${user.username}'s rap sheet`, iconURL: user.displayAvatarURL() })
    .setDescription(lines.join('\n'))
    .setFooter({ text: '/crime  ·  /gym  ·  /hit  ·  /shop  ·  /top' });
}

// Select menu of the crimes the player has unlocked (with live odds/cost).
function crimeMenu(player) {
  const options = logic.unlockedCrimes(player).slice(0, 25).map((c) => ({
    label: c.name,
    description: `${data.crimeSuccess(c, player.level)}% · ${c.energy}⚡ · ${money(c.min)}–${money(c.max)}`,
    value: c.id,
  }));
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('game:crime:pick').setPlaceholder('Choose a crime…').addOptions(options)
  );
}

function crimeEmbed(player, resultLine) {
  const eNow = logic.energyNow(player);
  const eMax = data.maxEnergy(player.level);
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('🕵️ Crimes')
    .setDescription(
      (resultLine ? resultLine + '\n\n' : '') +
        `⚡ Energy ${eNow}/${eMax}  •  ${money(player.cash)}  •  Level ${player.level}`
    )
    .setFooter({ text: 'Pick another crime, or come back tomorrow when your energy refills.' });
}

function gymComponents(disabled = false) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('game:gym:strength').setLabel('Train Strength').setStyle(ButtonStyle.Danger).setDisabled(disabled),
    new ButtonBuilder().setCustomId('game:gym:defense').setLabel('Train Defense').setStyle(ButtonStyle.Primary).setDisabled(disabled)
  );
}

function gymEmbed(player, resultLine) {
  const eNow = logic.energyNow(player);
  const eMax = data.maxEnergy(player.level);
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('🏋️ Gym')
    .setDescription(
      (resultLine ? resultLine + '\n\n' : '') +
        `💪 Strength **${player.strength}**   🛡️ Defense **${player.defense}**\n` +
        `⚡ Energy ${eNow}/${eMax} — each train costs 1⚡`
    );
}

// --- Shop (Phase 2) ---
function shopEmbed(player, resultLine) {
  const weapon = data.WEAPONS_BY_ID[player.weapon_id] ?? data.WEAPONS_BY_ID.fists;
  const armor = data.ARMORS_BY_ID[player.armor_id] ?? data.ARMORS_BY_ID.none;
  const prop = player.property_id ? data.PROPERTIES_BY_ID[player.property_id] : null;
  const list = (arr, ownedId) =>
    arr
      .filter((x) => x.cost > 0)
      .map((x) => `${x.id === ownedId ? '✅' : '•'} **${x.name}** — ${money(x.cost)}`)
      .join('\n');
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle('🛒 Black Market')
    .setDescription(
      (resultLine ? resultLine + '\n\n' : '') +
        `You have **${money(player.cash)}**.\n\n` +
        `__Weapons__ (equipped: ${weapon.name})\n${list(data.WEAPONS, player.weapon_id)}\n\n` +
        `__Armor__ (equipped: ${armor.name})\n${list(data.ARMORS, player.armor_id)}\n\n` +
        `__Property__ (owned: ${prop ? prop.name : 'none'})\n${list(data.PROPERTIES, player.property_id)}`
    )
    .setFooter({ text: 'Pick something below to buy it.' });
}

function shopMenu(player) {
  const opt = (cat, x) => ({
    label: `${x.name} — ${money(x.cost)}`,
    description:
      cat === 'property' ? `${money(x.perHour)}/hr` : cat === 'weapon' ? `×${x.mult} attack` : `×${x.mult} defense`,
    value: `${cat}:${x.id}`,
  });
  const options = [
    ...data.WEAPONS.filter((w) => w.cost > 0 && w.id !== player.weapon_id).map((w) => opt('weapon', w)),
    ...data.ARMORS.filter((a) => a.cost > 0 && a.id !== player.armor_id).map((a) => opt('armor', a)),
    ...data.PROPERTIES.filter((p) => p.id !== player.property_id).map((p) => opt('property', p)),
  ].slice(0, 25);
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder().setCustomId('game:shop:buy').setPlaceholder('Buy…').addOptions(options)
  );
}

function topEmbed(rows, resolveName) {
  const medal = (i) => ['🥇', '🥈', '🥉'][i] ?? `**${i + 1}.**`;
  const lines = rows.length
    ? rows.map((r, i) => `${medal(i)} ${resolveName(r.user_id)} — ${money(r.cash)}  •  Lv ${r.level}  •  ⭐${r.respect}`).join('\n')
    : '*No players yet — be the first with `/crime`.*';
  return new EmbedBuilder().setColor(COLOR).setTitle('🏆 Most Wanted (richest)').setDescription(lines);
}

// --- Paged manual (Phase 3) ---
const HELP_PAGES = [
  {
    title: 'Getting Started',
    body:
      'Welcome to the family. Every day your **energy** refills — spend it on ' +
      '`/crime` to earn cash and experience. Train at the `/gym` to get stronger, ' +
      'buy a `/shop` weapon, grab a property for passive income, and once a day you ' +
      'can `/hit` a rival to take their cash. Check `/mprofile` to see where you ' +
      'stand and `/top` for the leaderboard.',
  },
  {
    title: 'Crimes',
    body:
      'Bigger crimes pay more but are riskier, and unlock as you level up. ' +
      'Out-level a crime and it gets safer. Fail and you waste the energy — botch ' +
      "it badly and you'll spend a few hours in the hospital.",
  },
  {
    title: 'Combat',
    body:
      '`/hit @someone` pits your Strength (+ weapon) against their Defense ' +
      '(+ armor). Win and you pocket a cut of their cash; lose and **you** get ' +
      "hospitalised. You get one attack a day, and you can't punch down more than " +
      '5 levels.',
  },
  {
    title: 'Property',
    body:
      'Buy a property in `/shop` and it prints cash every hour, up to a full ' +
      "day's worth. Log in daily and `/collect` (or just `/mprofile`) before it " +
      'caps out.',
  },
  {
    title: 'Stats',
    body:
      'Strength wins the fights you start; Defense wins the ones you don\'t. ' +
      'Train whichever fits your style at the `/gym` — you can push hard for a few ' +
      'trains a day before your focus fades.',
  },
];

function helpEmbed(i) {
  const page = HELP_PAGES[i];
  return new EmbedBuilder()
    .setColor(COLOR)
    .setTitle(`📖 ${page.title}`)
    .setDescription(page.body)
    .setFooter({ text: `Page ${i + 1} of ${HELP_PAGES.length}` });
}

function helpComponents(i) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`game:help:${i - 1}`).setLabel('◀ Prev').setStyle(ButtonStyle.Secondary).setDisabled(i === 0),
    new ButtonBuilder().setCustomId(`game:help:${i + 1}`).setLabel('Next ▶').setStyle(ButtonStyle.Secondary).setDisabled(i === HELP_PAGES.length - 1)
  );
}

module.exports = {
  COLOR,
  money,
  bar,
  profileEmbed,
  crimeMenu,
  crimeEmbed,
  gymComponents,
  gymEmbed,
  shopEmbed,
  shopMenu,
  topEmbed,
  HELP_PAGES,
  helpEmbed,
  helpComponents,
};
