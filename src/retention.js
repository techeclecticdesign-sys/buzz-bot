// Database retention — prunes the local `messages` archive so storage stays
// bounded. Never touches Discord; only trims the bot's own DB copy.
//
//   Advert channels : pruned after ADVERT_RETENTION_DAYS   (default 365 = 1 year)
//   Other channels  : pruned after MESSAGE_RETENTION_DAYS  (default 730 = 2 years)
//   Deleted posts   : purged once past the repost-cooldown window
//   AI advert labels: purged LABEL_RETENTION_DAYS (default 90) after labelling,
//                     once their advert is gone or their prompt version retired;
//                     finished label batches (the fire log) after the same window
//
// A soft-deleted post (deleted_at set) is already logged + gone from Discord, so
// it's dropped once older than max(advert lockout) + 1 day — the window the advert
// failsafe's repost cooldown still reads deleted rows over. Its group-ad image
// bytes cascade away with it. Runs ~1min after boot, then daily, overlap-guarded.
// Disable with DB_RETENTION_ENABLED=false.
const db = require('./db');
const advertConfig = require('./advertConfig');
const config = require('./config');
const { PROMPT_VERSION } = require('./advertLabeller');

const DAY_MS = 24 * 60 * 60 * 1000;
const ENABLED = config.bool('DB_RETENTION_ENABLED', true);
// Clamped to ≥1: a negative value would put the cutoff in the future and prune
// the entire archive on the next tick.
const ADVERT_RETENTION_DAYS = config.num('ADVERT_RETENTION_DAYS', 365, { min: 1 });
const OTHER_RETENTION_DAYS = config.num('MESSAGE_RETENTION_DAYS', 730, { min: 1 });
// How long a soft-deleted row is kept. The floor is the longest advert lockout
// (so the repost cooldown never loses the row it needs) plus a day of margin;
// DELETED_RETENTION_DAYS can raise it but never drop below that floor.
const MAX_LOCKOUT_HOURS = Math.max(
  0,
  ...Object.values(advertConfig.TYPES || {}).map((t) => t.lockoutHours || 0),
);
const DELETED_KEEP_MS = Math.max(
  MAX_LOCKOUT_HOURS * 60 * 60 * 1000 + DAY_MS,
  config.num('DELETED_RETENTION_DAYS', 0) * DAY_MS,
);
// How long the labels of a gone advert are remembered (a repost of the same text
// reuses them instead of being scanned again), and how long the batch log is kept.
const LABEL_RETENTION_DAYS = config.num('LABEL_RETENTION_DAYS', 90, { min: 1 });
const INTERVAL_MS = DAY_MS; // prune once a day
const FIRST_RUN_DELAY_MS = 60_000; // let startup work settle first
const BATCH = 5000; // rows per DELETE, so the first prune can't lock the table
const BATCH_SPACING_MS = 500;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Delete every matching row in batches until a short page comes back.
async function pruneLoop(fn, label, noun = 'message(s)') {
  let total = 0;
  for (;;) {
    const n = await fn();
    total += n;
    if (n < BATCH) break;
    await sleep(BATCH_SPACING_MS);
  }
  if (total) console.log(`[retention] pruned ${total} ${label} ${noun} past retention.`);
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
    // AI advert labels of gone adverts / retired prompts, and the old fire log.
    const labelCutoff = new Date(Date.now() - LABEL_RETENTION_DAYS * DAY_MS);
    await pruneLoop(() => db.pruneAdvertLabels(labelCutoff, PROMPT_VERSION, BATCH), 'advert', 'label(s)');
    await pruneLoop(() => db.pruneLabelBatches(labelCutoff, BATCH), 'label', 'batch(es)');
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
  labelRetentionDays: LABEL_RETENTION_DAYS,
  run,
  schedule,
};
