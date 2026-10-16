// One-off audit: compare each member's stated age in the #age_verification
// channel (735579435000004747) against the birthdate they gave in the Google
// Form / sheet, computing their real age AS OF THE MOMENT they stated it. Any
// mismatch is flagged. Members whose first stated age was 15 or 18 are listed
// separately (the classic "just barely qualifies" values).
//
// Data sources
//   - Google Sheet (public CSV export): DOB + Discord member id per row.
//   - #age_verification message history (fetched live — the channel is in the
//     bot's IGNORE_CHANNELS so it's never in the DB): the age they typed and
//     WHEN they typed it.
// Matched by Discord member id.
//
// "The age they stated" = the member's FIRST message in the channel that parses
// to a plausible age (10-99), mirroring "initially stated on join" and skipping
// typos / birth-years (0, 1, 2008, ...). We compute their real age from the DOB
// as of that message's timestamp; if it differs from the typed age we flag it,
// recording the direction (claimed older / younger) and the gap.
//
// Run:  node src/ageAudit.js
// Uses the logger-bot's DISCORD_TOKEN from .env. No Google credentials needed
// (the sheet is fetched via its public CSV export). Writes a .txt + .csv report
// next to the project and prints a summary.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Client, Events, GatewayIntentBits } = require('discord.js');

// --- Config ---------------------------------------------------------------

const AGE_CHANNEL_ID = (process.env.AGE_VERIFY_CHANNEL_ID || '735579435000004747').trim();

// The Google Sheet, exported as CSV. gid pins the specific tab from the link.
const SHEET_ID = '1vSGqRT1PGcOtyvmqrd2YtKBYDGSIs34Rfwp9v3Ck0I0';
const SHEET_GID = '184627673';
const SHEET_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=csv&gid=${SHEET_GID}`;

// A typed number only counts as an age statement inside this band — filters out
// obvious non-ages (0, 1, a pasted birth year like 2008, "188" fat-fingers).
const AGE_MIN = 10;
const AGE_MAX = 99;

// Values that get their own section of the report ("just barely qualifies").
const SPLIT_AGES = new Set([15, 18]);

const REPORT_DIR = path.resolve(__dirname, '..');
const STAMP = new Date().toISOString().slice(0, 10);
const TXT_PATH = path.join(REPORT_DIR, `age-mismatch-report-${STAMP}.txt`);
const CSV_PATH = path.join(REPORT_DIR, `age-mismatch-report-${STAMP}.csv`);

// --- CSV parsing (RFC-4180: quoted fields, embedded commas/newlines, "") -----

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\r') {
      // handled by \n
    } else if (c === '\n') {
      row.push(field); rows.push(row); row = []; field = '';
    } else field += c;
  }
  // trailing field / row (no final newline)
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// --- Date helpers ----------------------------------------------------------

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Parse the sheet's DOB, e.g. "Feb-13-1996" -> {y,m,d}. Returns null for "?",
// blanks and anything unrecognised.
function parseDob(raw) {
  if (!raw) return null;
  const s = raw.trim();
  if (!s || s === '?') return null;
  const m = s.match(/^([A-Za-z]{3,})[-\/ ](\d{1,2})[-\/ ](\d{4})$/);
  if (!m) return null;
  const month = MONTHS[m[1].slice(0, 3).toLowerCase()];
  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (!month || !day || day > 31 || year < 1900 || year > 2100) return null;
  return { y: year, m: month, d: day };
}

// Whole years from a DOB to a point in time (UTC calendar). Mirrors "how old
// were you on that date": subtract a year if that year's birthday hasn't landed
// yet. Uses the message timestamp's UTC date.
function ageAt(dob, when) {
  const y = when.getUTCFullYear();
  const mo = when.getUTCMonth() + 1;
  const d = when.getUTCDate();
  let age = y - dob.y;
  if (mo < dob.m || (mo === dob.m && d < dob.d)) age--;
  return age;
}

// --- Sheet load ------------------------------------------------------------

// Find a column by matching its header text; fall back to a fixed index if the
// header ever moves/renames. Header row is the first row of the export.
function pickCol(headers, matcher, fallback) {
  const idx = headers.findIndex((h) => matcher(String(h).trim().toLowerCase()));
  return idx >= 0 ? idx : fallback;
}

async function loadSheet() {
  console.log(`Fetching sheet CSV…\n  ${SHEET_CSV_URL}`);
  const res = await fetch(SHEET_CSV_URL, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`Sheet fetch failed: HTTP ${res.status} ${res.statusText}. ` +
      'Is the sheet shared as "anyone with the link can view"?');
  }
  const text = await res.text();
  const rows = parseCsv(text);
  if (rows.length < 2) throw new Error('Sheet CSV had no data rows.');

  const headers = rows[0];
  const idCol   = pickCol(headers, (h) => h === 'id #' || h === 'id#' || h.includes('id #'), 9);
  const dobCol  = pickCol(headers, (h) => h.includes('dob'), 6);
  const userCol = pickCol(headers, (h) => h.includes('discord username'), 8);
  const nameCol = pickCol(headers, (h) => h.includes('display name') || h.includes('nickname'), 3);
  const ageCol  = pickCol(headers, (h) => h.includes('current age'), 4);

  const byId = new Map();
  let noId = 0, noDob = 0, dupes = 0;
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    const idRaw = (cells[idCol] || '').replace(/[^\d]/g, '');
    if (!/^\d{17,20}$/.test(idRaw)) { if (cells.some((c) => c && c.trim())) noId++; continue; }
    const dob = parseDob(cells[dobCol]);
    const rec = {
      id: idRaw,
      dob,
      dobRaw: (cells[dobCol] || '').trim(),
      username: (cells[userCol] || '').trim(),
      displayName: (cells[nameCol] || '').trim(),
      formAge: (cells[ageCol] || '').trim(),
      rowNum: r + 1,
    };
    if (!dob) noDob++;
    if (byId.has(idRaw)) {
      dupes++;
      // Prefer the row that actually has a parseable DOB.
      const prev = byId.get(idRaw);
      if (!prev.dob && dob) byId.set(idRaw, rec);
    } else {
      byId.set(idRaw, rec);
    }
  }
  console.log(`  parsed ${byId.size} unique members (headers: id=${idCol}, dob=${dobCol}). ` +
    `${noDob} without a usable DOB, ${noId} rows without a valid id, ${dupes} duplicate id(s).`);
  return byId;
}

// --- Discord channel scan --------------------------------------------------

function toInt(content) {
  return /^[+-]?\d+$/.test(content.trim()) ? parseInt(content.trim(), 10) : NaN;
}

async function withRetry(fn, label, attempts = 6) {
  let delay = 5000;
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (err) {
      const status = err.status ?? err.httpStatus;
      if ((status >= 400 && status < 500) || i >= attempts) throw err;
      console.warn(`  ! ${label}: ${err.message} — retry in ${delay / 1000}s (${i}/${attempts - 1})`);
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 2, 60_000);
    }
  }
}

// Walk the whole channel newest->oldest; keep, per author, the EARLIEST message
// that parses to a plausible age. Returns Map<authorId, {age, ts, msgId, tries}>.
async function scanChannel(channel) {
  const stated = new Map();
  let before;
  let scanned = 0;
  for (;;) {
    const batch = await withRetry(
      () => channel.messages.fetch({ limit: 100, before }),
      `#${channel.name} history`
    );
    if (batch.size === 0) break;
    for (const msg of batch.values()) {
      scanned++;
      if (msg.author?.bot) continue;
      const n = toInt(msg.content || '');
      if (Number.isNaN(n)) continue;
      const prev = stated.get(msg.author.id) || { tries: [] };
      prev.tries.push(n);
      // Only a plausible age counts as "the age they stated"; keep the oldest.
      if (n >= AGE_MIN && n <= AGE_MAX) {
        if (prev.ts === undefined || msg.createdTimestamp < prev.ts) {
          prev.age = n;
          prev.ts = msg.createdTimestamp;
          prev.msgId = msg.id;
        }
      }
      stated.set(msg.author.id, prev);
    }
    before = batch.last().id;
    process.stdout.write(`  scanned ${scanned} messages, ${stated.size} authors with a number\r`);
  }
  process.stdout.write('\n');
  return stated;
}

// --- Report ----------------------------------------------------------------

function fmtDob(dob) {
  return `${String(dob.y)}-${String(dob.m).padStart(2, '0')}-${String(dob.d).padStart(2, '0')}`;
}

function buildRow(rec, st, guildId) {
  const when = new Date(st.ts);
  const actual = ageAt(rec.dob, when);
  const delta = st.age - actual; // + = claimed older than DOB, - = claimed younger
  return {
    id: rec.id,
    username: rec.username,
    displayName: rec.displayName,
    dob: fmtDob(rec.dob),
    statedAge: st.age,
    statedAt: when.toISOString().replace('T', ' ').slice(0, 16) + ' UTC',
    actualAge: actual,
    delta,
    direction: delta > 0 ? 'claimed OLDER' : 'claimed younger',
    link: `https://discord.com/channels/${guildId}/${AGE_CHANNEL_ID}/${st.msgId}`,
    retries: st.tries.length,
  };
}

function section(title, rows) {
  const lines = [`\n${'='.repeat(78)}`, title, '='.repeat(78)];
  if (rows.length === 0) { lines.push('  (none)'); return lines.join('\n'); }
  for (const x of rows) {
    lines.push(
      `\n  ${x.displayName || x.username || '(unknown)'}  —  member ${x.id}` +
      (x.username ? `  (@${x.username})` : ''),
      `    DOB ${x.dob}  |  stated ${x.statedAge} on ${x.statedAt}  |  actually ${x.actualAge}` +
      `  |  ${x.direction} by ${Math.abs(x.delta)} yr${Math.abs(x.delta) === 1 ? '' : 's'}` +
      (x.retries > 1 ? `  |  typed ${x.retries} numbers` : ''),
      `    ${x.link}`
    );
  }
  return lines.join('\n');
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(allFlagged) {
  const header = ['group', 'member_id', 'discord_username', 'display_name', 'dob',
    'stated_age', 'stated_at_utc', 'actual_age_at_statement', 'delta_stated_minus_actual',
    'direction', 'numbers_typed', 'message_link'];
  const lines = [header.join(',')];
  for (const x of allFlagged) {
    lines.push([
      x.group, x.id, x.username, x.displayName, x.dob, x.statedAge, x.statedAt,
      x.actualAge, x.delta, x.direction, x.retries, x.link,
    ].map(csvEscape).join(','));
  }
  fs.writeFileSync(CSV_PATH, lines.join('\n'));
}

// --- Main ------------------------------------------------------------------

// Dry run: load + parse the sheet only, print samples and a self-test of the
// age math, then exit — no Discord login, no channel scan.
async function sheetOnly() {
  const sheet = await loadSheet();
  const withDob = [...sheet.values()].filter((r) => r.dob);
  console.log(`\nSample parsed rows (first 5 with a DOB):`);
  for (const r of withDob.slice(0, 5)) {
    console.log(`  ${r.id}  DOB ${fmtDob(r.dob)} (raw "${r.dobRaw}")  @${r.username}  "${r.displayName}"  formAge=${r.formAge}`);
  }
  // Self-test of ageAt using the user's example: stated 18 on 2026-09-20,
  // DOB 2008-09-21 -> real age 17 -> mismatch.
  const ex = ageAt({ y: 2008, m: 9, d: 21 }, new Date(Date.UTC(2026, 8, 20)));
  console.log(`\nSelf-test ageAt(DOB 2008-09-21, on 2026-09-20) = ${ex} (expected 17 -> mismatch vs stated 18)`);
  const ex2 = ageAt({ y: 2008, m: 9, d: 21 }, new Date(Date.UTC(2026, 8, 21)));
  console.log(`Self-test ageAt(DOB 2008-09-21, on 2026-09-21) = ${ex2} (expected 18 -> birthday landed)`);
}

if (process.argv.includes('--sheet-only')) {
  sheetOnly().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
  return;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

client.once(Events.ClientReady, async () => {
  try {
    console.log(`Logged in as ${client.user.tag}.`);
    const sheet = await loadSheet();

    const channel = await client.channels.fetch(AGE_CHANNEL_ID);
    if (!channel) throw new Error(`Could not fetch channel ${AGE_CHANNEL_ID}.`);
    const guildId = channel.guildId || channel.guild?.id || '';
    console.log(`Scanning #${channel.name} (${AGE_CHANNEL_ID})… this walks the full history.`);
    const stated = await scanChannel(channel);

    // Join by member id.
    const flaggedSplit = [];   // stated 15 or 18
    const flaggedOther = [];   // every other mismatch
    let matched = 0, verified = 0, agree = 0;
    const noStatement = [];    // in sheet w/ DOB but never typed a plausible age
    const noDobList = [];      // in sheet but no usable DOB (can't verify)

    for (const rec of sheet.values()) {
      const st = stated.get(rec.id);
      if (st) matched++;
      if (!rec.dob) { if (st) noDobList.push({ rec, st }); continue; }
      if (!st || st.age === undefined) { noStatement.push(rec); continue; }
      verified++;
      const row = buildRow(rec, st, guildId);
      if (row.delta === 0) { agree++; continue; }
      if (SPLIT_AGES.has(row.statedAge)) { row.group = 'stated-15-or-18'; flaggedSplit.push(row); }
      else { row.group = 'other'; flaggedOther.push(row); }
    }

    // Worst first: biggest overstatement at the top of each section.
    const byDelta = (a, b) => b.delta - a.delta;
    flaggedSplit.sort(byDelta);
    flaggedOther.sort(byDelta);

    const summary = [
      'Age-verification audit — stated age vs. DOB (at time of statement)',
      `Generated ${new Date().toISOString()}`,
      '',
      `Sheet members with a valid id ......... ${sheet.size}`,
      `  matched to a channel message ....... ${matched}`,
      `  had a usable DOB + age statement .... ${verified}  (verifiable)`,
      `    agreed (no mismatch) ............. ${agree}`,
      `    FLAGGED mismatch ................. ${flaggedSplit.length + flaggedOther.length}`,
      `      stated 15 or 18 on join ........ ${flaggedSplit.length}`,
      `      other stated age ............... ${flaggedOther.length}`,
      `  DOB present but never typed an age .. ${noStatement.length}`,
      `  matched but no usable DOB in sheet .. ${noDobList.length}`,
    ].join('\n');

    const report = [
      summary,
      section('FLAGGED — initially stated 15 or 18 on join', flaggedSplit),
      section('FLAGGED — all other age mismatches', flaggedOther),
    ].join('\n');

    fs.writeFileSync(TXT_PATH, report + '\n');
    writeCsv([...flaggedSplit, ...flaggedOther]);

    console.log('\n' + summary);
    console.log(`\nReports written:\n  ${TXT_PATH}\n  ${CSV_PATH}`);
  } catch (err) {
    console.error('\nAudit failed:', err);
    process.exitCode = 1;
  } finally {
    client.destroy();
    process.exit(process.exitCode || 0);
  }
});

process.on('unhandledRejection', (err) => { console.error('[unhandled]', err); process.exit(1); });

client.login(process.env.DISCORD_TOKEN).catch((err) => {
  console.error('Login failed:', err);
  process.exit(1);
});
