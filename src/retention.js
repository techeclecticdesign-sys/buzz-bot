// Database retention — periodically prunes the local `messages` archive so
// storage stays bounded (Neon's free tier is small). This NEVER deletes
// anything from Discord — it only trims the bot's own database copy. (The one
// thing that deletes real Discord posts is the advert failsafe bouncing a
// rule-breaking advert; removing old ads from Discord is YAGPDB's job, or done
// manually.)
//
//   Advert channels : pruned after ADVERT_RETENTION_DAYS   (default 365 = 1 year)
//   Other channels  : pruned after MESSAGE_RETENTION_DAYS  (default 730 = 2 years)
//   Deleted posts   : purged once past the repost-cooldown window (see below)
//
// A deleted post (deleted_at set) has already been logged to the log channel and
// removed from Discord, so there's no reason to keep it long-term — and dropping
// it reclaims any stored group-ad image bytes via ON DELETE CASCADE. We can't
// purge it immediately, though: the advert failsafe's repost cooldown reads
// deleted advert rows (getLastDeletedAdvert) for up to the advert's lockout
// window after it was posted. So deleted rows are kept at least
// max(lockoutHours) + 1 day, then purged.
//
// "Advert channels" are the advert failsafe's configured channels
// (src/advertConfig.live.js / .test.js). Runs shortly after boot, then daily,
// and is guarded against overlapping runs. Disable with DB_RETENTION_ENABLED=false.
const db = require('./db');
const advertConfig = require('./advertConfig');

const DAY_MS = 24 * 60 * 60 * 1000;
const ENABLED = process.env.DB_RETENTION_ENABLED !== 'false';
// Clamped to ≥1: a negative value would put the cutoff in the future and prune
// the entire archive on the next tick.
const ADVERT_RETENTION_DAYS = Math.max(1, Number(process.env.ADVERT_RETENTION_DAYS) || 365);
const OTHER_RETENTION_DAYS = Math.max(1, Number(process.env.MESSAGE_RETENTION_DAYS) || 730);
// How long a soft-deleted row is kept. The floor is the longest advert lockout
// (so the repost cooldown never loses the row it needs) plus a day of margin;
// DELETED_RETENTION_DAYS can raise it but never drop below that floor.
const MAX_LOCKOUT_HOURS = Math.max(
  0,
  ...Object.values(advertConfig.TYPES || {}).map((t) => t.lockoutHours || 0),
);
const DELETED_KEEP_MS = Math.max(
  MAX_LOCKOUT_HOURS * 60 * 60 * 1000 + DAY_MS,
  (Number(process.env.DELETED_RETENTION_DAYS) || 0) * DAY_MS,
);
const INTERVAL_MS = DAY_MS; // prune once a day
const FIRST_RUN_DELAY_MS = 60_000; // let startup work settle first
const BATCH = 5000; // rows per DELETE, so the first prune can't lock the table
const BATCH_SPACING_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Delete every matching row in batches until a short page comes back.
async function pruneLoop(fn, label) {
  let total = 0;
  for (;;) {
    const n = await fn();
    total += n;
    if (n < BATCH) break;
    await sleep(BATCH_SPACING_MS);
  }
  if (total) console.log(`[retention] pruned ${total} ${label} message(s) past retention.`);
  return total;
}

let running = false;

// Prune advert channels (1y) and everything else (2y). Guarded so a slow prune
// that spills past the daily tick won't stack on itself.
async function run() {
  if (!ENABLED || running) return;
  running = true;
  try {
    const advertIds = advertConfig.ALL_ADVERT_CHANNELS;
    const advertCutoff = new Date(Date.now() - ADVERT_RETENTION_DAYS * DAY_MS);
    const otherCutoff = new Date(Date.now() - OTHER_RETENTION_DAYS * DAY_MS);
    if (advertIds.length) {
      await pruneLoop(() => db.pruneMessagesInChannels(advertIds, advertCutoff, BATCH), 'advert');
    }
    await pruneLoop(() => db.pruneMessagesNotInChannels(advertIds, otherCutoff, BATCH), 'non-advert');
    // Purge deleted-and-logged posts past the cooldown window (frees their
    // group-ad image bytes via cascade).
    const deletedCutoff = new Date(Date.now() - DELETED_KEEP_MS);
    await pruneLoop(() => db.pruneSoftDeletedMessages(deletedCutoff, BATCH), 'deleted');
  } catch (err) {
    console.error('[retention] prune failed:', err.message);
  } finally {
    running = false;
  }
}

// Kick off the first prune shortly after boot, then daily. Timers are unref'd so
// they never keep the process alive on their own.
function schedule() {
  if (!ENABLED) return;
  const tick = () => run().catch((err) => console.error('[retention]', err.message));
  setTimeout(tick, FIRST_RUN_DELAY_MS).unref?.();
  setInterval(tick, INTERVAL_MS).unref?.();
}

module.exports = {
  ENABLED,
  advertRetentionDays: ADVERT_RETENTION_DAYS,
  otherRetentionDays: OTHER_RETENTION_DAYS,
  deletedKeepDays: Math.round(DELETED_KEEP_MS / DAY_MS),
  run,
  schedule,
};
