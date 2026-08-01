// All game balance/config in one place — tune here, no logic changes needed.
// Adapted from MCCodes v2 (MIT) and retuned for a ~2-3 min once-a-day loop.
// See mafia-game/DESIGN.md for the rationale behind every number.

// ---- Progression ----
// MCCodes v2 original: experience required to reach the next level.
function xpToNext(level) {
  return Math.round(Math.pow(level + 1, 3) * 2.2);
}

// ---- Energy (one daily pool; refills to max over 24h, lazily computed) ----
// MCCodes granted +2 energy AND +2 brave per level. With brave+energy merged
// into this one daily pool we keep the +2 energy grant. base/refill are
// daily-design (the original refilled per-minute across two separate pools).
const ENERGY = { base: 10, perLevel: 2, refillHours: 24 };
function maxEnergy(level) {
  return ENERGY.base + (level - 1) * ENERGY.perLevel;
}

// ---- Health (MCCodes: +50 HP per level) ----
const HP = { base: 100, perLevel: 50, regenPerHour: 20 };
function maxHp(level) {
  return HP.base + (level - 1) * HP.perLevel;
}

// ---- Crimes (the cash faucet). XP earned = round(cash / 8). ----
const CRIMES = [
  { id: 'pickpocket', name: 'Pickpocket a tourist', unlock: 1, energy: 2, base: 45, min: 50, max: 150 },
  { id: 'shoplift', name: 'Shoplift the corner store', unlock: 1, energy: 2, base: 42, min: 80, max: 220 },
  { id: 'mug', name: 'Mug a drunk', unlock: 2, energy: 3, base: 40, min: 150, max: 400 },
  { id: 'breakcar', name: 'Break into a car', unlock: 3, energy: 3, base: 38, min: 300, max: 700 },
  { id: 'burgle', name: 'Burgle a house', unlock: 5, energy: 4, base: 36, min: 600, max: 1300 },
  { id: 'scam', name: 'Run a phone scam', unlock: 7, energy: 4, base: 33, min: 1100, max: 2400 },
  { id: 'boost', name: 'Boost a car', unlock: 9, energy: 5, base: 31, min: 1900, max: 3800 },
  { id: 'armed', name: 'Armed robbery', unlock: 12, energy: 5, base: 28, min: 3200, max: 6500 },
  { id: 'hijack', name: 'Hijack a shipment', unlock: 15, energy: 6, base: 25, min: 5800, max: 11000 },
  { id: 'bank', name: 'Bank heist', unlock: 18, energy: 7, base: 22, min: 9500, max: 19000 },
  { id: 'casino', name: 'Casino job', unlock: 22, energy: 8, base: 20, min: 17000, max: 34000 },
  { id: 'bigscore', name: 'The Big Score', unlock: 26, energy: 8, base: 18, min: 32000, max: 64000 },
];
// Success%: out-level a crime and it gets safer, capped 5–92.
function crimeSuccess(crime, level) {
  return Math.max(5, Math.min(92, crime.base + (level - crime.unlock) * 2));
}
// MCCodes jailed 50% of failed crimes. DESIGN.md softens that: most failures
// are a clean getaway, but 25% are a botched job — hospitalised 1–3 hours.
const CRIME_FAIL = { hospitalChance: 0.25, hospitalMinMinutes: 60, hospitalMaxMinutes: 180 };

// ---- Gym (train Strength / Defense; 1 energy each) ----
// MCCodes formula: rand(1,3)/rand(800,1000)*rand(800,1000)*((will+20)/150) per
// energy. We have no willpower stat, so willConstant stands in for `will`.
// After softCapTrains trains in a UTC day, gains halve (daily soft cap).
const GYM = { costEnergy: 1, willConstant: 100, softCapTrains: 5 };

// ---- Combat (Phase 2) ----
const COMBAT = {
  variance: 0.15, // ±15% roll on each side
  stealPct: 0.15, // winner takes 15% of loser's on-hand cash …
  cashCapPerLevel: 2000, // … capped at 2000 × loser level
  hospitalHours: 3, // loser is hospitalised (shielded from re-attack)
  maxLevelGapDown: 5, // can't attack someone >5 levels below you
  attackCooldownHours: 24, // one initiated attack per day
};

// ---- Shop (Phase 2) ----
const WEAPONS = [
  { id: 'fists', name: 'Fists', cost: 0, mult: 1.0 },
  { id: 'knife', name: 'Knife', cost: 2000, mult: 1.15 },
  { id: 'pistol', name: 'Pistol', cost: 15000, mult: 1.4 },
  { id: 'smg', name: 'SMG', cost: 80000, mult: 1.8 },
  { id: 'rifle', name: 'Rifle', cost: 400000, mult: 2.3 },
];
const ARMORS = [
  { id: 'none', name: 'No armor', cost: 0, mult: 1.0 },
  { id: 'vest', name: 'Vest', cost: 10000, mult: 1.2 },
  { id: 'kevlar', name: 'Kevlar', cost: 60000, mult: 1.5 },
  { id: 'riot', name: 'Riot gear', cost: 300000, mult: 2.0 },
];
// ---- Property (Phase 2) — passive income, capped at 24h of accrual ----
const PROPERTIES = [
  { id: 'corner', name: 'Corner store', cost: 5000, perHour: 200 },
  { id: 'nightclub', name: 'Nightclub', cost: 50000, perHour: 1500 },
  { id: 'casino', name: 'Casino', cost: 500000, perHour: 12000 },
];
const PROPERTY_CAP_HOURS = 24;

const byId = (arr) => Object.fromEntries(arr.map((x) => [x.id, x]));

module.exports = {
  xpToNext,
  ENERGY,
  maxEnergy,
  HP,
  maxHp,
  CRIMES,
  CRIMES_BY_ID: byId(CRIMES),
  crimeSuccess,
  CRIME_FAIL,
  GYM,
  COMBAT,
  WEAPONS,
  WEAPONS_BY_ID: byId(WEAPONS),
  ARMORS,
  ARMORS_BY_ID: byId(ARMORS),
  PROPERTIES,
  PROPERTIES_BY_ID: byId(PROPERTIES),
  PROPERTY_CAP_HOURS,
};
