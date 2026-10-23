// AI advert keywords. Once a day, from LABEL_HOUR (8am US Eastern), this sends
// every advert that has no labels yet to a Claude Code routine, one batch at a
// time, through the routine's fire API. The routine labels each batch (14
// categories + the fandoms offered + optional self-stated author age) and writes
// the result straight into the DB
// with labeller_api.submit_advert_labels() (db/advertLabelsSchema.js). rpc-web shows the
// labels to staff and filters on them.
//
// A day's run, one step per tick:
//   1. copy labels onto reposts: text with a known rev is never sent twice
//   2. pack the newest unlabelled ads posted before the run began (≤ LABEL_BATCH_MAX_BYTES)
//   3. record the batch as 'sent', then fire it
//   4. wait for the routine to submit it, then go again
// until nothing is left. Any failure — a fire error, a batch the routine fails
// or never submits — ends the day's run; the rest waits for tomorrow.
//
// Off unless LABEL_ENABLED=true. Never logs the routine token or advert text.
//
// CLI (no Discord login; uses .env):
//   node src/advertLabeller.js --dry-run          build the next batch and log it, fire nothing
//   node src/advertLabeller.js --once [--limit N] fire one batch now (first-run test)
//   node src/advertLabeller.js --all [--max N]    label everything now, batch after batch
//   node src/advertLabeller.js --status           recent batches
require('dotenv').config();
const { createHash, randomUUID } = require('node:crypto');
const db = require('./db');
const config = require('./config');
const advertConfig = require('./advertConfig');
const { advertContentHash } = require('./advertHash');
const { stripAttribution } = require('./advertAttribution');

const ENABLED = config.flag('LABEL_ENABLED');
const DRY_RUN = config.flag('LABEL_DRY_RUN');
const ROUTINE_ID = (process.env.ROUTINE_ID || '').trim();
const ROUTINE_TOKEN = (process.env.ROUTINE_TOKEN || '').trim();
// The fire API's dated beta header. "none" sends no header (the API's latest).
const ROUTINE_BETA = (process.env.ROUTINE_BETA || 'experimental-cc-routine-2026-04-01').trim();
const LABELLER_TOKEN = process.env.LABELLER_TOKEN || '';
const PROMPT_VERSION = (process.env.LABEL_PROMPT_VERSION || 'rpc14-v1').trim();
// The fire API caps `text` at 65,536 characters; a byte is at least a character.
const MAX_BYTES = config.num('LABEL_BATCH_MAX_BYTES', 60000, { min: 4000, max: 65000 });
// The API allows 30 fires per routine per hour; usage is the real limit.
const MAX_RUNS_PER_DAY = config.num('LABEL_MAX_RUNS_PER_DAY', 30, { min: 1 });
const STALE_HOURS = config.num('LABEL_STALE_HOURS', 3, { min: 1 });
const MAX_ATTEMPTS = config.num('LABEL_MAX_ATTEMPTS', 3, { min: 1 });
const RUN_HOUR = config.num('LABEL_HOUR', 8, { min: 0, max: 23 });
const CHANNELS = config.idList('LABEL_CHANNELS').length
  ? config.idList('LABEL_CHANNELS')
  : advertConfig.LABEL_CHANNELS;

const TIME_ZONE = 'America/New_York';
const TICK_MS = 2 * 60 * 1000; // how often a run checks on its batch
const FIRE_TIMEOUT_MS = 30_000;
const FIRE_URL = (id) =>
  `https://api.anthropic.com/v1/claude_code/routines/${encodeURIComponent(id)}/fire`;

// --- Pure helpers (exported for the spec) ---

// The Eastern wall clock, DST-aware: { date: 'YYYY-MM-DD', year, month, day, hour, minute }.
function easternWall(now = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone: TIME_ZONE,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .formatToParts(now)
      .map((x) => [x.type, x.value])
  );
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
  };
}

// The instant the Eastern clock reads hour:00 on `date` ('YYYY-MM-DD').
function easternInstant(date, hour) {
  const [y, m, d] = date.split('-').map(Number);
  const target = Date.UTC(y, m - 1, d, hour);
  let guess = target;
  for (let i = 0; i < 3; i++) {
    const w = easternWall(new Date(guess));
    guess += target - Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  }
  return new Date(guess);
}

// An advert's text as the routine sees it: custom emoji reduced to their names
// (the name can carry meaning, the id can't), mentions to placeholders, runs of
// blank lines collapsed. Only saves bytes; the rev is always of the stored text.
function compactForLabelling(content) {
  return stripAttribution(String(content ?? ''))
    .replace(/<a?:(\w{1,32}):\d{5,}>/g, ':$1:')
    .replace(/<@!?\d{5,}>/g, '@user')
    .replace(/<@&\d{5,}>/g, '@role')
    .replace(/<#\d{5,}>/g, '#channel')
    .replace(/<t:-?\d+(?::[tTdDfFR])?>/g, '(time)')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Greedy, in the given order (newest first): take every ad that still fits.
// ads: [{ id, content, rev }]. Ids stay strings; the batch never exceeds maxBytes.
function packBatch(ads, { batchId, promptVersion, maxBytes, limit = Infinity }) {
  const head = { batch_id: batchId, prompt_version: promptVersion };
  let bytes = Buffer.byteLength(JSON.stringify({ ...head, ads: [] }), 'utf8');
  const picked = [];
  for (const ad of ads) {
    if (picked.length >= limit) break;
    const entry = { id: String(ad.id), content: compactForLabelling(ad.content) };
    const add = Buffer.byteLength(JSON.stringify(entry), 'utf8') + (picked.length ? 1 : 0);
    if (bytes + add > maxBytes) continue; // too big for what's left; a smaller one may fit
    picked.push({ ad, entry });
    bytes += add;
  }
  const text = JSON.stringify({ ...head, ads: picked.map((p) => p.entry) });
  return { text, bytes: Buffer.byteLength(text, 'utf8'), ads: picked.map((p) => p.ad) };
}

// A fire response → what to do. ok: store the session; otherwise `kind` decides
// how loudly to stop: auth (401/403: bad token or no access), rate (429),
// server (5xx / network), request (400 incl. a paused routine, 404).
function interpretFire(status, body, retryAfter) {
  if (status >= 200 && status < 300) {
    return {
      ok: true,
      sessionId: body?.claude_code_session_id ?? null,
      sessionUrl: body?.claude_code_session_url ?? null,
    };
  }
  const type = body?.error?.type;
  const message = typeof body?.error?.message === 'string' ? body.error.message.slice(0, 200) : '';
  const error = `HTTP ${status}${type ? ` ${type}` : ''}${message ? `: ${message}` : ''}`;
  if (status === 401 || status === 403) return { ok: false, kind: 'auth', error };
  if (status === 429) return { ok: false, kind: 'rate', error, retryAfter: retryAfter ?? null };
  if (status >= 500) return { ok: false, kind: 'server', error };
  return { ok: false, kind: 'request', error };
}

// --- Effects ---

async function fireRoutine(text) {
  const headers = {
    Authorization: `Bearer ${ROUTINE_TOKEN}`,
    'anthropic-version': '2023-06-01',
    'Content-Type': 'application/json',
  };
  if (ROUTINE_BETA && ROUTINE_BETA !== 'none') headers['anthropic-beta'] = ROUTINE_BETA;
  let res;
  try {
    res = await fetch(FIRE_URL(ROUTINE_ID), {
      method: 'POST',
      headers,
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(FIRE_TIMEOUT_MS),
    });
  } catch (err) {
    const why = err?.name === 'TimeoutError' ? 'timed out' : err?.message || 'failed';
    return { ok: false, kind: 'server', error: `network error: ${why}` };
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    // not JSON: the status decides
  }
  return interpretFire(res.status, body, res.headers.get('retry-after'));
}

// Labels for reposts, then the next batch to send (or null). `before` bounds the
// run to ads posted before it began; write=false (dry run) changes nothing.
async function prepareBatch(before, { limit = Infinity, write = true } = {}) {
  const rows = await db.getLabelCandidates(CHANNELS, PROMPT_VERSION, before);
  const pending = [];
  for (const r of rows) {
    const rev = advertContentHash(r.content);
    if (rev && rev !== r.labelled_rev) pending.push({ id: r.id, content: r.content, rev });
  }

  // Text already labelled under another message: copy, don't send.
  const known = new Map(
    (await db.getLabelsByRev(PROMPT_VERSION, [...new Set(pending.map((a) => a.rev))])).map((k) => [
      k.content_rev,
      k,
    ])
  );
  let inherited = 0;
  const unseen = [];
  const revsQueued = new Set();
  for (const ad of pending) {
    const source = known.get(ad.rev);
    if (source) {
      if (write) await db.inheritLabels(ad.id, PROMPT_VERSION, ad.rev, source);
      inherited++;
    } else if (!revsQueued.has(ad.rev)) {
      // Identical text twice in the backlog: send one; the twin inherits next step.
      revsQueued.add(ad.rev);
      unseen.push(ad);
    }
  }

  const attempts = await db.getLabelAttempts(PROMPT_VERSION, unseen.map((a) => a.id));
  const ready = unseen.filter((a) => (attempts.get(a.id) ?? 0) < MAX_ATTEMPTS);
  const gaveUp = unseen.length - ready.length;

  if (!ready.length) return { batch: null, inherited, waiting: 0, gaveUp };
  const batchId = randomUUID();
  const batch = packBatch(ready, { batchId, promptVersion: PROMPT_VERSION, maxBytes: MAX_BYTES, limit });
  batch.batchId = batchId;
  return { batch, inherited, waiting: ready.length - batch.ads.length, gaveUp };
}

// Record and fire one batch. Returns the fire result.
async function sendBatch(batch) {
  await db.insertLabelBatch(
    batch.batchId,
    PROMPT_VERSION,
    batch.ads.map((a) => ({ id: a.id, rev: a.rev }))
  );
  const result = await fireRoutine(batch.text);
  if (result.ok) {
    await db.recordLabelFire(batch.batchId, result.sessionId, result.sessionUrl);
    console.log(
      `[labeller] fired batch ${batch.batchId}: ${batch.ads.length} ad(s), ${batch.bytes} bytes → ` +
        `${result.sessionUrl ?? 'session url not returned'}`
    );
  } else {
    await db.failLabelBatch(batch.batchId, `fire: ${result.error}`);
    if (result.kind === 'auth') {
      console.error(
        `[labeller] !!! the routine refused the fire (${result.error}). Check ROUTINE_ID / ` +
          'ROUTINE_TOKEN (a regenerated token revokes the old one). No more fires until restart.'
      );
    } else {
      const retry = result.retryAfter ? ` (Retry-After ${result.retryAfter}s)` : '';
      console.error(`[labeller] fire failed: ${result.error}${retry}`);
    }
  }
  return result;
}

function logPrepared(prefix, { batch, inherited, waiting, gaveUp }) {
  const parts = [];
  if (inherited) parts.push(`${inherited} repost(s) reused existing labels`);
  if (gaveUp) parts.push(`${gaveUp} ad(s) skipped after ${MAX_ATTEMPTS} failed attempts`);
  if (batch) {
    parts.push(`next batch ${batch.batchId}: ${batch.ads.length} ad(s), ${batch.bytes} bytes`);
    if (waiting) parts.push(`${waiting} more waiting`);
  } else {
    parts.push('nothing left to label');
  }
  console.log(`${prefix} ${parts.join('; ')}.`);
}

// Store the hash of LABELLER_TOKEN (the routine's x-labeller-token), if set.
async function syncLabellerToken() {
  if (!LABELLER_TOKEN) return false;
  const hash = createHash('sha256').update(LABELLER_TOKEN, 'utf8').digest('hex');
  await db.setLabellerTokenHash(hash);
  return true;
}

// --- The daily run ---

let running = false;
let finishedDate = null; // Eastern date whose run is over
let authBlocked = false; // a 401/403: config must change, which means a restart
let onRunOver = null; // scheduleAdvertLabeller's hook: the same-fandom report

function finish(date, why) {
  finishedDate = date;
  console.log(`[labeller] ${date} run over: ${why}.`);
  // Every batch is saved or given up on by now, so the labels are all in.
  if (onRunOver && !DRY_RUN) {
    Promise.resolve()
      .then(() => onRunOver({ date, runStart: easternInstant(date, RUN_HOUR) }))
      .catch((err) => console.error('[labeller] run-over hook failed:', err.message));
  }
}

// One step of today's run (see the header). Exported for the spec.
async function step(now = new Date()) {
  const wall = easternWall(now);
  if (authBlocked || wall.hour < RUN_HOUR || finishedDate === wall.date) return;
  const runStart = easternInstant(wall.date, RUN_HOUR);

  const expired = await db.expireStaleLabelBatches(STALE_HOURS);
  if (expired.length) console.warn(`[labeller] ${expired.length} batch(es) never submitted — expired.`);

  const today = await db.labelBatchSummarySince(runStart);
  // A run starts only in the LABEL_HOUR hour; one already going carries on.
  if (today.fired === 0 && wall.hour > RUN_HOUR) return finish(wall.date, 'missed the start hour');
  if (today.failed > 0) return finish(wall.date, 'a batch failed or was never submitted');
  if (await db.getInFlightLabelBatch()) return; // the routine is still on it
  if (today.fired >= MAX_RUNS_PER_DAY) return finish(wall.date, `LABEL_MAX_RUNS_PER_DAY (${MAX_RUNS_PER_DAY}) reached`);

  const prepared = await prepareBatch(runStart, { write: !DRY_RUN });
  logPrepared(DRY_RUN ? '[labeller] (dry run)' : '[labeller]', prepared);
  if (!prepared.batch) return finish(wall.date, 'all caught up');
  if (DRY_RUN) return finish(wall.date, 'dry run, nothing fired');

  const result = await sendBatch(prepared.batch);
  if (!result.ok) {
    if (result.kind === 'auth') authBlocked = true;
    finish(wall.date, `fire failed (${result.error})`);
  }
}

// runOver({ date, runStart }) is called once each day's run is over (not on a dry run).
function scheduleAdvertLabeller({ runOver } = {}) {
  onRunOver = runOver ?? null;
  // The hash is stored whether or not sending is on, so a hand-fired test run can submit.
  syncLabellerToken().catch((err) => console.error('[labeller] token sync failed:', err.message));
  if (!ENABLED) {
    console.log('[labeller] disabled (LABEL_ENABLED is not true).');
    return;
  }
  if (!DRY_RUN && (!ROUTINE_ID || !ROUTINE_TOKEN)) {
    console.warn('[labeller] LABEL_ENABLED but ROUTINE_ID / ROUTINE_TOKEN unset — not armed.');
    return;
  }
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      await step();
    } catch (err) {
      console.error('[labeller] run error:', err.message);
      finishedDate = easternWall().date; // wait for tomorrow
    } finally {
      running = false;
    }
  };
  setInterval(tick, TICK_MS).unref?.();
  tick();
  console.log(
    `[labeller] armed${DRY_RUN ? ' (DRY RUN)' : ''} — daily from ${String(RUN_HOUR).padStart(2, '0')}:00 ` +
      `${TIME_ZONE}, ${CHANNELS.length} channel(s), prompt ${PROMPT_VERSION}.`
  );
}

// --- Label everything now (CLI) ---

const WAIT_POLL_MS = 30_000;
const WAIT_LIMIT_MS = 60 * 60 * 1000; // a 50-ad batch takes minutes; an hour means it died

// Wait for the routine to submit a batch. Gives up (expires it) after WAIT_LIMIT_MS.
async function waitForBatch(batchId, { pollMs = WAIT_POLL_MS, limitMs = WAIT_LIMIT_MS } = {}) {
  const started = Date.now();
  for (;;) {
    const batch = await db.getLabelBatch(batchId);
    if (!batch || batch.status !== 'sent') return batch;
    if (Date.now() - started > limitMs) {
      await db.expireLabelBatch(batchId);
      return { ...batch, status: 'expired', error: 'not submitted in time' };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

// The daily run without the clock: batch after batch, each fired once the last is
// saved, until nothing posted before `cutoff` is left. Stops at the first failure.
// For a first backfill or after a prompt change; it uses subscription usage.
async function runAll({ maxBatches = MAX_RUNS_PER_DAY, cutoff = new Date(), wait = {} } = {}) {
  const inFlight = await db.getInFlightLabelBatch();
  if (inFlight) throw new Error(`batch ${inFlight.batch_id} is still waiting on the routine`);
  let saved = 0;
  for (let n = 1; n <= maxBatches; n++) {
    const prepared = await prepareBatch(cutoff);
    logPrepared(`[labeller] (${n}/${maxBatches})`, prepared);
    if (!prepared.batch) return { done: true, batches: n - 1, saved };
    const result = await sendBatch(prepared.batch);
    if (!result.ok) return { done: false, batches: n, saved, why: `fire failed (${result.error})` };
    const batch = await waitForBatch(prepared.batch.batchId, wait);
    saved += batch?.accepted ?? 0;
    console.log(
      `[labeller] batch ${prepared.batch.batchId}: ${batch?.status}, ` +
        `${batch?.accepted ?? 0}/${prepared.batch.ads.length} saved (${saved} so far).`
    );
    if (batch?.status === 'failed' || batch?.status === 'expired') {
      return { done: false, batches: n, saved, why: `batch ${batch.status}${batch.error ? `: ${batch.error}` : ''}` };
    }
  }
  return { done: false, batches: maxBatches, saved, why: `stopped after --max ${maxBatches} batches` };
}

// --- CLI ---

async function cli(argv) {
  const arg = (name) => argv.includes(name);
  const limitAt = argv.indexOf('--limit');
  const limit = limitAt >= 0 ? Math.max(1, Number(argv[limitAt + 1]) || 1) : Infinity;

  if (await syncLabellerToken()) console.log('[labeller] labeller token hash stored.');

  if (arg('--status')) {
    console.table(await db.recentLabelBatches(10));
    return;
  }
  const expired = await db.expireStaleLabelBatches(STALE_HOURS);
  if (expired.length) console.warn(`[labeller] expired ${expired.length} stale batch(es).`);

  if (arg('--dry-run')) {
    const prepared = await prepareBatch(new Date(), { limit, write: false });
    logPrepared('[labeller] (dry run)', prepared);
    if (prepared.batch) console.log(`[labeller] ids: ${prepared.batch.ads.map((a) => a.id).join(', ')}`);
    return;
  }
  if (arg('--once')) {
    if (!ROUTINE_ID || !ROUTINE_TOKEN) throw new Error('set ROUTINE_ID and ROUTINE_TOKEN first');
    const inFlight = await db.getInFlightLabelBatch();
    if (inFlight) throw new Error(`batch ${inFlight.batch_id} is still waiting on the routine`);
    const prepared = await prepareBatch(new Date(), { limit });
    logPrepared('[labeller]', prepared);
    if (prepared.batch) {
      const result = await sendBatch(prepared.batch);
      if (!result.ok) process.exitCode = 1;
    }
    return;
  }
  if (arg('--all')) {
    if (!ROUTINE_ID || !ROUTINE_TOKEN) throw new Error('set ROUTINE_ID and ROUTINE_TOKEN first');
    const maxAt = argv.indexOf('--max');
    const maxBatches = maxAt >= 0 ? Math.max(1, Number(argv[maxAt + 1]) || 1) : MAX_RUNS_PER_DAY;
    const out = await runAll({ maxBatches });
    console.log(
      out.done
        ? `[labeller] all caught up: ${out.batches} batch(es), ${out.saved} ad(s) saved.`
        : `[labeller] stopped: ${out.why}. ${out.saved} ad(s) saved; run again to continue.`
    );
    if (!out.done) process.exitCode = 1;
    return;
  }
  console.log('usage: node src/advertLabeller.js --dry-run | --once [--limit N] | --all [--max N] | --status');
}

if (require.main === module) {
  cli(process.argv.slice(2))
    .catch((err) => {
      console.error('[labeller]', err.message);
      process.exitCode = 1;
    })
    .finally(() => db.pool.end());
}

module.exports = {
  scheduleAdvertLabeller,
  PROMPT_VERSION,
  // for the spec
  easternWall,
  easternInstant,
  compactForLabelling,
  packBatch,
  interpretFire,
  prepareBatch,
  runAll,
  step,
};
