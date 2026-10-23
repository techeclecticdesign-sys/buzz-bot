// Env-var parsers, the process-level values the entrypoint reads, a MANIFEST of
// every env var, and validate(). Feature modules read their own vars through
// these parsers. dotenv must be loaded before this module.

// --- Parsers (read process.env at call time) ---

// True unless the var is the literal 'false'; unset/empty → dflt. Default-on knobs.
function bool(name, dflt) {
  const v = process.env[name];
  if (v === undefined || v === '') return dflt;
  return v !== 'false';
}

// True only for the literal 'true'. Default-off knobs.
function flag(name) {
  return process.env[name] === 'true';
}

// Number(x) || dflt (unset/empty/non-numeric/0 all fall back to dflt), then
// clamped to [min, max]. Knobs that must accept 0 (e.g. LINK_CHECK_GRACE_HOURS)
// parse inline instead.
function num(name, dflt, { min, max } = {}) {
  let v = Number(process.env[name]) || dflt;
  if (min !== undefined) v = Math.max(min, v);
  if (max !== undefined) v = Math.min(max, v);
  return v;
}

// Comma-separated ID/name list → trimmed, non-empty entries.
function idList(name) {
  return (process.env[name] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

// --- Process-level values (read by the entrypoint) ---

const TOKEN = process.env.DISCORD_TOKEN;
const DATABASE_URL = process.env.DATABASE_URL;
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID;
const IGNORE_BOTS = flag('IGNORE_BOTS');
// Off disables the archive/embeds/change tracking and makes LOG_CHANNEL_ID
// optional. Other enabled features can still need message/member intents.
const LOGGING_ENABLED = bool('LOGGING_ENABLED', true);

// Every env var, with kind/default/owner. Drives validate()'s numeric check.
// req: true = required; req: 'logging' = required only when LOGGING_ENABLED.
const MANIFEST = [
  // Core / process
  { name: 'DISCORD_TOKEN', kind: 'secret', req: true, feature: 'core' },
  { name: 'DATABASE_URL', kind: 'secret', req: true, feature: 'core' },
  { name: 'LOG_CHANNEL_ID', kind: 'string', req: 'logging', feature: 'core' },
  { name: 'LOGGING_ENABLED', kind: 'bool', default: true, feature: 'core' },
  { name: 'IGNORE_BOTS', kind: 'flag', default: false, feature: 'core' },
  { name: 'IGNORE_CHANNELS', kind: 'idList', default: [], feature: 'core' },
  { name: 'JSON_ARCHIVE_DIR', kind: 'string', default: '', feature: 'core' },
  // Failsafe
  { name: 'FAILSAFE_ENABLED', kind: 'bool', default: true, feature: 'failsafe' },
  { name: 'YAGPDB_BOT_IDS', kind: 'idList', default: [], feature: 'failsafe' },
  { name: 'AGE_PLEASE_ROLE_ID', kind: 'string', default: '735544386678554738', feature: 'failsafe' },
  { name: 'ADVERT_MIN_OFFLINE_SECS', kind: 'num', default: 60, feature: 'failsafe' },
  // Onboarding failsafe
  { name: 'MEMBER_AGES_ENABLED', kind: 'bool', default: true, feature: 'member-ages' },
  { name: 'AGE_VERIFY_CHANNEL_ID', kind: 'string', default: '', feature: 'onboarding' },
  { name: 'RULES_PLEASE_ROLE_ID', kind: 'string', default: '634585076524646401', feature: 'onboarding' },
  { name: 'NEWBIE_ROLE_ID', kind: 'string', default: '456657052136243210', feature: 'onboarding' },
  { name: 'RULES_MESSAGE_ID', kind: 'string', default: '1385675552601411605', feature: 'onboarding' },
  { name: 'RULES_EMOJI_ID', kind: 'string', default: '658510846779195423', feature: 'onboarding' },
  { name: 'RULES_EMOJI_NAME', kind: 'string', default: 'rpc', feature: 'onboarding' },
  { name: 'MIN_AGE', kind: 'num', default: 15, feature: 'onboarding' },
  { name: 'MAX_AGE', kind: 'num', default: 75, feature: 'onboarding' },
  // Advert enforcement
  { name: 'ADVERT_ENV', kind: 'string', default: 'live', feature: 'advert' },
  { name: 'ADVERT_EDIT_CHECKS', kind: 'bool', default: true, feature: 'advert' },
  { name: 'INFRACTION_RECHECK', kind: 'bool', default: true, feature: 'advert' },
  { name: 'INFRACTION_RECHECK_DELETE', kind: 'bool', default: true, feature: 'advert' },
  { name: 'INFRACTION_RECHECK_POLL_SECS', kind: 'num', default: 60, min: 30, feature: 'advert' },
  { name: 'ADVERT_RECONCILE_ENABLED', kind: 'bool', default: true, feature: 'advert' },
  { name: 'ADVERT_RECONCILE_HOUR', kind: 'num', default: 3, min: 0, max: 23, feature: 'advert' },
  // AI advert keywords (advertLabeller.js)
  { name: 'LABEL_ENABLED', kind: 'flag', default: false, feature: 'labeller' },
  { name: 'LABEL_DRY_RUN', kind: 'flag', default: false, feature: 'labeller', note: 'build + log the batch, fire nothing' },
  { name: 'ROUTINE_ID', kind: 'string', default: '', feature: 'labeller', note: 'trig_...' },
  { name: 'ROUTINE_TOKEN', kind: 'secret', default: '', feature: 'labeller' },
  { name: 'ROUTINE_BETA', kind: 'string', default: 'experimental-cc-routine-2026-04-01', feature: 'labeller', note: '"none" sends no beta header' },
  { name: 'LABELLER_TOKEN', kind: 'secret', default: '', feature: 'labeller', note: 'only its sha256 is stored' },
  { name: 'LABEL_PROMPT_VERSION', kind: 'string', default: 'rpc14-v1', feature: 'labeller' },
  { name: 'LABEL_HOUR', kind: 'num', default: 8, min: 0, max: 23, feature: 'labeller' },
  { name: 'LABEL_BATCH_MAX_BYTES', kind: 'num', default: 60000, min: 4000, max: 65000, feature: 'labeller' },
  { name: 'LABEL_MAX_RUNS_PER_DAY', kind: 'num', default: 30, min: 1, feature: 'labeller' },
  { name: 'LABEL_STALE_HOURS', kind: 'num', default: 3, min: 1, feature: 'labeller' },
  { name: 'LABEL_MAX_ATTEMPTS', kind: 'num', default: 3, min: 1, feature: 'labeller' },
  { name: 'LABEL_CHANNELS', kind: 'idList', default: [], feature: 'labeller', note: 'unset = advertConfig LABEL_CHANNELS' },
  { name: 'FANDOM_REPORT_CHANNEL_ID', kind: 'string', default: '406618336508510209', feature: 'labeller', note: 'same-fandom report after each run; empty = off' },
  { name: 'ADREVIEWERS', kind: 'idList', default: [], feature: 'labeller', note: 'user ids pinged on each same-fandom report' },
  { name: 'FANDOM_REPORT_ADVERT_CHANNELS', kind: 'idList', default: [], feature: 'labeller', note: 'unset = advertConfig ONE_ON_ONE_CHANNELS' },
  { name: 'LABEL_RETENTION_DAYS', kind: 'num', default: 90, min: 1, feature: 'retention', note: 'labels of gone adverts + the batch log' },
  // rpc-web cache purge (sitePurge.js)
  { name: 'RPC_WEB_URL', kind: 'string', default: '', feature: 'site-purge', note: 'e.g. https://www.roleplaycentral.net; empty = off' },
  { name: 'ADVERT_PURGE_SECRET', kind: 'secret', default: '', feature: 'site-purge', note: "the same as rpc-web's" },
  { name: 'SITE_PURGE_DAILY_UTC_HOUR', kind: 'num', default: 16, min: 0, max: 23, feature: 'site-purge' },
  // Retention
  { name: 'DB_RETENTION_ENABLED', kind: 'bool', default: true, feature: 'retention' },
  { name: 'ADVERT_RETENTION_DAYS', kind: 'num', default: 365, min: 1, feature: 'retention' },
  { name: 'MESSAGE_RETENTION_DAYS', kind: 'num', default: 730, min: 1, feature: 'retention' },
  { name: 'DELETED_RETENTION_DAYS', kind: 'num', default: 0, feature: 'retention' },
  // Link check
  { name: 'LINK_CHECK_CHANNELS', kind: 'idList', default: [], feature: 'linkcheck' },
  { name: 'LINK_CHECK_NOTIFY_CHANNEL_ID', kind: 'string', default: '', feature: 'linkcheck' },
  { name: 'LINK_CHECK_HOUR', kind: 'num', default: 4, min: 0, max: 23, feature: 'linkcheck' },
  { name: 'LINK_CHECK_GRACE_HOURS', kind: 'num', default: 24, feature: 'linkcheck', note: '0 disables auto-deletion (parsed inline to preserve 0)' },
  { name: 'LINK_CHECK_PENDING_MINS', kind: 'num', default: 60, min: 15, feature: 'linkcheck' },
  // Member stats
  { name: 'MEMBER_STATS_ENABLED', kind: 'bool', default: true, feature: 'memberstats' },
  { name: 'MEMBER_STATS_MIDNIGHT_OFFSET_MIN', kind: 'num', default: 10, min: 1, feature: 'memberstats' },
  // Game
  { name: 'GAME_ENABLED', kind: 'bool', default: true, feature: 'game' },
  { name: 'GAME_ANNOUNCE_CHANNEL_ID', kind: 'string', default: '', feature: 'game' },
  { name: 'GAME_ANNOUNCE_CRIME_MIN', kind: 'num', default: 10000, feature: 'game' },
  // Polls
  { name: 'POLLS_ENABLED', kind: 'bool', default: true, feature: 'polls' },
  { name: 'STAFF_ROLES', kind: 'idList', default: [], feature: 'polls' },
  // Adult check
  { name: 'ADULT_CHECK_ENABLED', kind: 'bool', default: true, feature: 'adultcheck' },
  { name: 'ADULT_CHECK_CHANNEL_ID', kind: 'string', default: '1534208635889123548', feature: 'adultcheck' },
  // Discord questionnaire -> Google Sheets bridge
  { name: 'SURVEY_SUBMISSION_CHANNEL_ID', kind: 'string', default: '1534208635889123548', feature: 'survey' },
  { name: 'SURVEY_SHEETS_WEB_APP_URL', kind: 'secret', default: '', feature: 'survey' },
  { name: 'SURVEY_SHEETS_SHARED_SECRET', kind: 'secret', default: '', feature: 'survey' },
  // Marketer pfp guard
  { name: 'PFP_GUARD_ENABLED', kind: 'bool', default: true, feature: 'pfpguard' },
  { name: 'PFP_GUARD_KICK', kind: 'bool', default: true, feature: 'pfpguard', note: 'false = report matches without kicking' },
  { name: 'PFP_MATCH_MAX_DISTANCE', kind: 'num', default: 8, min: 0, max: 20, feature: 'pfpguard' },
  { name: 'PFP_GUARD_LOG_CHANNEL_ID', kind: 'string', default: '', feature: 'pfpguard', note: 'unset = log channel' },
  // Commands
  { name: 'MOD_ROLES', kind: 'idList', default: [], feature: 'commands' },
  // Backfill script
  { name: 'BACKFILL_ADVERTS_ONLY', kind: 'flag', default: false, feature: 'backfill' },
  { name: 'BACKFILL_INCREMENTAL', kind: 'flag', default: false, feature: 'backfill' },
];

function validate() {
  if (!TOKEN || !DATABASE_URL) {
    console.error('Missing required env vars: DISCORD_TOKEN, DATABASE_URL');
    process.exit(1);
  }
  if (LOGGING_ENABLED && !LOG_CHANNEL_ID) {
    console.error('LOGGING_ENABLED but LOG_CHANNEL_ID is unset — set it, or set LOGGING_ENABLED=false.');
    process.exit(1);
  }
  // Warn (don't exit) when a numeric knob is set to a non-number.
  for (const v of MANIFEST) {
    if (v.kind !== 'num') continue;
    const raw = process.env[v.name];
    if (raw !== undefined && raw !== '' && !Number.isFinite(Number(raw))) {
      console.warn(`[config] ${v.name}="${raw}" is not a number — using default ${v.default}.`);
    }
  }
}

module.exports = {
  bool,
  flag,
  num,
  idList,
  TOKEN,
  DATABASE_URL,
  LOG_CHANNEL_ID,
  IGNORE_BOTS,
  LOGGING_ENABLED,
  MANIFEST,
  validate,
};
