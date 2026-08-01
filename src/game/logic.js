// Pure game logic — no I/O, fully unit-testable. Callers load a player row,
// call materialize() to apply time-based regen, run an action, then persist.
const data = require('./gameData');

const randInt = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const HOUR_MS = 3600000;

// Apply time-based regen (energy, hp) up to "now". Mutates and returns player.
// Cheap and idempotent — safe to call at the start of every action.
function materialize(player, now = Date.now()) {
  // Energy refills to max over refillHours.
  const eMax = data.maxEnergy(player.level);
  const ePerMs = eMax / (data.ENERGY.refillHours * HOUR_MS);
  const eElapsed = now - new Date(player.energy_updated_at).getTime();
  player.energy = Math.min(eMax, Number(player.energy) + eElapsed * ePerMs);
  player.energy_updated_at = new Date(now);

  // HP regen — only time spent outside a hospital stay counts, whether the
  // stay is ongoing (no regen yet) or ended between check-ins (regen from release).
  const hMax = data.maxHp(player.level);
  const hospEnd = player.hospital_until ? Math.min(now, new Date(player.hospital_until).getTime()) : 0;
  const regenFrom = Math.max(new Date(player.hp_updated_at).getTime(), hospEnd);
  player.hp = Math.min(hMax, Number(player.hp) + (Math.max(0, now - regenFrom) / HOUR_MS) * data.HP.regenPerHour);
  player.hp_updated_at = new Date(now);
  return player;
}

function isHospitalised(player, now = Date.now()) {
  return !!player.hospital_until && now < new Date(player.hospital_until).getTime();
}

// Add XP, rolling over as many levels as earned. Returns levels gained.
function applyXp(player, xpGain) {
  player.exp += xpGain;
  let gained = 0;
  while (player.exp >= data.xpToNext(player.level)) {
    player.exp -= data.xpToNext(player.level);
    player.level += 1;
    gained += 1;
  }
  if (gained) player.hp = data.maxHp(player.level); // full heal on level up
  return gained;
}

// Attempt a crime. Assumes the caller already verified unlock/energy/hospital.
// Deducts energy, applies rewards/penalties, mutates player. Returns a summary.
function doCrime(player, crime, now = Date.now()) {
  player.energy = Number(player.energy) - crime.energy;
  const success = Math.random() * 100 < data.crimeSuccess(crime, player.level);
  if (success) {
    const cash = randInt(crime.min, crime.max);
    const xp = Math.round(cash / 8);
    player.cash = Number(player.cash) + cash;
    const levels = applyXp(player, xp);
    return { success: true, cash, xp, levels };
  }
  // A failed crime is usually a clean getaway, but sometimes the job is
  // botched — a hospital stay (no HP loss, unlike a combat trip).
  if (Math.random() < data.CRIME_FAIL.hospitalChance) {
    const mins = randInt(data.CRIME_FAIL.hospitalMinMinutes, data.CRIME_FAIL.hospitalMaxMinutes);
    player.hospital_until = new Date(now + mins * 60000);
    return { success: false, botched: true };
  }
  return { success: false, botched: false };
}

// pg returns DATE columns as JS Dates at *local* midnight — render them back
// to YYYY-MM-DD via local components so the day never shifts across timezones.
function dayString(d) {
  if (!(d instanceof Date)) return d;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Train a stat once (1 energy). Diminishing focus past the daily soft cap.
function doGym(player, stat, now = Date.now()) {
  // Reset the per-day train counter on a new UTC day. Always store the day as
  // a string — writing a Date back to the DATE column can shift it a day.
  const today = new Date(now).toISOString().slice(0, 10);
  if (dayString(player.train_day) !== today) player.trains_today = 0;
  player.train_day = today;
  player.energy = Number(player.energy) - data.GYM.costEnergy;
  // MCCodes gym formula with a fixed willpower stand-in.
  let gain = Math.max(
    1,
    Math.round((randInt(1, 3) / randInt(800, 1000)) * randInt(800, 1000) * ((data.GYM.willConstant + 20) / 150))
  );
  const soft = player.trains_today >= data.GYM.softCapTrains;
  if (soft) gain = Math.max(1, Math.floor(gain / 2));
  player[stat] += gain;
  player.trains_today += 1;
  return { stat, gain, soft };
}

// --- Combat (Phase 2) ---

// A stat rolled ±variance and scaled by an equipment multiplier.
function effStat(stat, mult) {
  return stat * mult * (1 + (Math.random() * 2 - 1) * data.COMBAT.variance);
}

// Resolve an attack. Both players are already locked + materialized, and the
// caller has validated cooldown / level gap / hospital. Mutates both, consumes
// the attacker's daily attack, and returns a summary.
function resolveAttack(attacker, defender, now = Date.now()) {
  const wpn = data.WEAPONS_BY_ID[attacker.weapon_id]?.mult ?? 1;
  const arm = data.ARMORS_BY_ID[defender.armor_id]?.mult ?? 1;
  attacker.last_attack_at = new Date(now);

  if (effStat(attacker.strength, wpn) > effStat(defender.defense, arm)) {
    const cap = data.COMBAT.cashCapPerLevel * defender.level;
    const steal = Math.min(Math.floor(Number(defender.cash) * data.COMBAT.stealPct), cap);
    defender.cash = Number(defender.cash) - steal;
    attacker.cash = Number(attacker.cash) + steal;
    const dl3 = defender.level * defender.level * defender.level; // MCCodes: defender level cubed
    const xp = randInt(Math.floor(dl3 / 2), dl3);
    const levels = applyXp(attacker, xp);
    attacker.respect += 1;
    defender.hp = Math.max(1, data.maxHp(defender.level) * 0.1);
    defender.hospital_until = new Date(now + data.COMBAT.hospitalHours * HOUR_MS);
    return { won: true, steal, xp, levels };
  }
  // Attacker picked the fight and lost: they take the hospital trip.
  attacker.hp = Math.max(1, data.maxHp(attacker.level) * 0.1);
  attacker.hospital_until = new Date(now + data.COMBAT.hospitalHours * HOUR_MS);
  return { won: false };
}

function attackCooldownLeftMs(attacker, now = Date.now()) {
  if (!attacker.last_attack_at) return 0;
  const left = data.COMBAT.attackCooldownHours * HOUR_MS - (now - new Date(attacker.last_attack_at).getTime());
  return Math.max(0, left);
}

// --- Property income (Phase 2), capped at PROPERTY_CAP_HOURS of accrual ---
function propertyIncome(player, now = Date.now()) {
  if (!player.property_id) return 0;
  const prop = data.PROPERTIES_BY_ID[player.property_id];
  if (!prop) return 0;
  const since = player.property_collected_at ? new Date(player.property_collected_at).getTime() : now;
  const hours = Math.min(data.PROPERTY_CAP_HOURS, Math.max(0, (now - since) / HOUR_MS));
  return Math.floor(hours * prop.perHour);
}

function collectProperty(player, now = Date.now()) {
  const income = propertyIncome(player, now);
  if (income > 0) player.cash = Number(player.cash) + income;
  if (player.property_id) player.property_collected_at = new Date(now);
  return income;
}

// Convenience getters for the UI.
function energyNow(player) {
  return Math.floor(Number(player.energy));
}
function unlockedCrimes(player) {
  return data.CRIMES.filter((c) => player.level >= c.unlock);
}

module.exports = {
  materialize,
  isHospitalised,
  applyXp,
  doCrime,
  doGym,
  resolveAttack,
  attackCooldownLeftMs,
  propertyIncome,
  collectProperty,
  energyNow,
  unlockedCrimes,
  randInt,
  HOUR_MS,
};
