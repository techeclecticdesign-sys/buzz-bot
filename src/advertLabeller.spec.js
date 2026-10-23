const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const db = require('./db');
const sitePurge = require('./sitePurge');
const { advertContentHash } = require('./advertHash');
const {
  easternInstant,
  easternWall,
  compactForLabelling,
  packBatch,
  interpretFire,
  prepareBatch,
  runAll,
  step,
  PROMPT_VERSION,
} = require('./advertLabeller');

// Snowflakes past Number.MAX_SAFE_INTEGER: one trip through Number would change them.
const SNOWFLAKES = ['1428390012345678901', '1428390012345678902', '1428390012345678903'];

test('easternInstant is 8am New York time across DST', () => {
  assert.equal(easternInstant('2026-01-15', 8).toISOString(), '2026-01-15T13:00:00.000Z'); // EST
  assert.equal(easternInstant('2026-07-15', 8).toISOString(), '2026-07-15T12:00:00.000Z'); // EDT
  assert.equal(easternInstant('2026-03-08', 8).toISOString(), '2026-03-08T12:00:00.000Z'); // spring forward day
  assert.equal(easternInstant('2026-11-01', 8).toISOString(), '2026-11-01T13:00:00.000Z'); // fall back day
  const w = easternWall(new Date('2026-07-15T12:30:00Z'));
  assert.deepEqual([w.date, w.hour, w.minute], ['2026-07-15', 8, 30]);
});

test('compactForLabelling keeps emoji names, drops ids, mentions and blank-line runs', () => {
  assert.equal(
    compactForLabelling('Hi <:genre_fantasy:1147031234567890> <a:spin:9876543210>\n\n\n\nby <@123456789> in <#123456789>  \n<t:1700000000:R>'),
    'Hi :genre_fantasy: :spin:\n\nby @user in #channel\n(time)'
  );
});

test('packBatch never exceeds the byte limit and keeps ids as strings', () => {
  const ads = [];
  for (let i = 0; i < 200; i++) {
    const id = (10n ** 18n + BigInt(i) * 7919n).toString();
    ads.push({ id, rev: `r${i}`, content: `ad ${i} ${'é✨'.repeat(50 + ((i * 37) % 700))}` });
  }
  for (const maxBytes of [4000, 20000, 60000]) {
    const { text, bytes, ads: picked } = packBatch(ads, { batchId: 'b', promptVersion: 'rpc14-v1', maxBytes });
    assert.ok(bytes <= maxBytes, `${bytes} > ${maxBytes}`);
    assert.equal(bytes, Buffer.byteLength(text, 'utf8'));
    const parsed = JSON.parse(text);
    assert.deepEqual(Object.keys(parsed), ['batch_id', 'prompt_version', 'ads']);
    assert.deepEqual(parsed.ads.map((a) => a.id), picked.map((a) => a.id));
    for (const a of parsed.ads) {
      assert.equal(typeof a.id, 'string');
      assert.deepEqual(Object.keys(a), ['id', 'content']); // nothing else spends the cap
    }
  }
});

test('packBatch keeps the newest-first order and fills gaps with smaller ads', () => {
  const ads = [
    { id: SNOWFLAKES[0], rev: 'a', content: 'x'.repeat(300) },
    { id: SNOWFLAKES[1], rev: 'b', content: 'y'.repeat(5000) }, // too big for what's left
    { id: SNOWFLAKES[2], rev: 'c', content: 'z'.repeat(100) },
  ];
  const { ads: picked, text } = packBatch(ads, { batchId: 'b', promptVersion: 'v', maxBytes: 1000 });
  assert.deepEqual(picked.map((a) => a.id), [SNOWFLAKES[0], SNOWFLAKES[2]]);
  assert.ok(text.includes(`"id":"${SNOWFLAKES[0]}"`));
  assert.equal(packBatch(ads, { batchId: 'b', promptVersion: 'v', maxBytes: 60000, limit: 1 }).ads.length, 1);
});

test('interpretFire maps the fire API responses', () => {
  assert.deepEqual(
    interpretFire(200, { type: 'routine_fire', claude_code_session_id: 'session_1', claude_code_session_url: 'https://claude.ai/code/session_1' }),
    { ok: true, sessionId: 'session_1', sessionUrl: 'https://claude.ai/code/session_1' }
  );
  const err = (type, message) => ({ type: 'error', error: { type, message } });
  assert.equal(interpretFire(401, err('authentication_error', 'bad token')).kind, 'auth');
  assert.equal(interpretFire(403, err('permission_error', 'no')).kind, 'auth');
  const rate = interpretFire(429, err('rate_limit_error', 'slow down'), '120');
  assert.deepEqual([rate.kind, rate.retryAfter], ['rate', '120']);
  assert.equal(interpretFire(503, null).kind, 'server');
  assert.equal(interpretFire(400, err('invalid_request_error', 'routine is paused')).error,
    'HTTP 400 invalid_request_error: routine is paused');
});

// --- prepareBatch over a stubbed data layer ---

const originals = {};
function stubDb(overrides) {
  for (const [name, fn] of Object.entries(overrides)) {
    if (!(name in originals)) originals[name] = db[name];
    db[name] = fn;
  }
}
afterEach(() => {
  for (const [name, fn] of Object.entries(originals)) db[name] = fn;
});

// What the labeller hands sitePurge, in place of sending it.
let purgeReports = [];
sitePurge.report = (rows) => purgeReports.push(rows);
afterEach(() => {
  purgeReports = [];
});

test('prepareBatch: a labelled ad is skipped, an edit is sent again, a repost inherits', async () => {
  const [labelled, edited, repost, fresh, twin] = SNOWFLAKES.concat(['1428390012345678904', '1428390012345678905']);
  const inherited = [];
  stubDb({
    getLabelCandidates: async () => [
      { id: labelled, content: 'Fantasy RP', labelled_rev: advertContentHash('Fantasy  RP ') }, // same text, whitespace aside
      { id: edited, content: 'Now a horror RP', labelled_rev: advertContentHash('Was a fantasy RP') },
      { id: repost, content: 'A bumped ad', labelled_rev: null },
      { id: fresh, content: 'Brand new ad', labelled_rev: null },
      { id: twin, content: 'Brand new ad', labelled_rev: null }, // same text as `fresh`
    ],
    getLabelsByRev: async (_v, revs) =>
      revs.includes(advertContentHash('A bumped ad'))
        ? [{ message_id: '1', content_rev: advertContentHash('A bumped ad'), labels: [], categories: [], firm_categories: [], fandoms: [] }]
        : [],
    inheritLabels: async (id) => inherited.push(id),
    getLabelAttempts: async () => new Map(),
  });

  const { batch, inherited: n } = await prepareBatch(new Date());
  assert.deepEqual(inherited, [repost]);
  assert.equal(n, 1);
  assert.deepEqual(batch.ads.map((a) => a.id), [edited, fresh]); // twin waits to inherit
  assert.equal(batch.ads[0].rev, advertContentHash('Now a horror RP'));
});

test('prepareBatch: dry run writes nothing; ads past the attempt limit are skipped', async () => {
  let wrote = false;
  stubDb({
    getLabelCandidates: async () => [
      { id: SNOWFLAKES[0], content: 'repost text', labelled_rev: null },
      { id: SNOWFLAKES[1], content: 'poison ad', labelled_rev: null },
    ],
    getLabelsByRev: async () => [
      { message_id: '1', content_rev: advertContentHash('repost text'), labels: [], categories: [], firm_categories: [], fandoms: [] },
    ],
    inheritLabels: async () => {
      wrote = true;
    },
    getLabelAttempts: async () => new Map([[SNOWFLAKES[1], 3]]),
  });
  const out = await prepareBatch(new Date(), { write: false });
  assert.equal(wrote, false);
  assert.equal(out.batch, null);
  assert.equal(out.gaveUp, 1);
});

test('runAll fires batch after batch until nothing is left, and stops at a batch never saved', async () => {
  const realFetch = global.fetch;
  let fires = 0;
  global.fetch = async () => {
    fires++;
    return {
      status: 200,
      headers: { get: () => null },
      json: async () => ({ claude_code_session_id: `s${fires}`, claude_code_session_url: `https://claude.ai/code/s${fires}` }),
    };
  };
  try {
    // Two rounds of work, then nothing: each batch is saved ('done').
    let round = 0;
    const statuses = [];
    const labelledSinceCalls = [];
    const before = Date.now();
    stubDb({
      labelledSince: async (version, since) => {
        labelledSinceCalls.push({ version, since });
        return [{ id: SNOWFLAKES[0], channelId: '504322272618610688' }];
      },
      getInFlightLabelBatch: async () => null,
      getLabelCandidates: async () =>
        ++round <= 2 ? [{ id: SNOWFLAKES[round - 1], content: `ad ${round}`, labelled_rev: null }] : [],
      getLabelsByRev: async () => [],
      inheritLabels: async () => {},
      getLabelAttempts: async () => new Map(),
      insertLabelBatch: async () => {},
      recordLabelFire: async () => {},
      failLabelBatch: async () => {},
      expireLabelBatch: async () => {},
      getLabelBatch: async (id) => (statuses.push(id), { batch_id: id, status: 'done', accepted: 1 }),
    });
    const ok = await runAll({ maxBatches: 10, wait: { pollMs: 1 } });
    assert.deepEqual(ok, { done: true, batches: 2, saved: 2 });
    assert.equal(fires, 2);
    // The run's labels go to sitePurge: everything labelled since it began.
    assert.equal(labelledSinceCalls.length, 1);
    assert.equal(labelledSinceCalls[0].version, PROMPT_VERSION);
    assert.ok(labelledSinceCalls[0].since.getTime() <= before);
    assert.deepEqual(purgeReports, [[{ id: SNOWFLAKES[0], channelId: '504322272618610688' }]]);

    // A batch the routine never saves: expired after the wait limit, and the run stops.
    let expired = null;
    stubDb({
      getLabelCandidates: async () => [{ id: SNOWFLAKES[0], content: 'ad', labelled_rev: null }],
      getLabelBatch: async (id) => ({ batch_id: id, status: 'sent', accepted: null }),
      expireLabelBatch: async (id) => {
        expired = id;
      },
    });
    const stopped = await runAll({ maxBatches: 10, wait: { pollMs: 1, limitMs: 5 } });
    assert.equal(stopped.done, false);
    assert.equal(stopped.batches, 1);
    assert.match(stopped.why, /expired/);
    assert.ok(expired);
    assert.equal(fires, 3);
    assert.equal(purgeReports.length, 2, 'a stopped run reports what it labelled too');
  } finally {
    global.fetch = realFetch;
  }
});

test("the daily run's end reports the ads labelled since it began", async () => {
  const runStart = easternInstant('2026-10-21', 8);
  let asked = null;
  stubDb({
    expireStaleLabelBatches: async () => [],
    labelBatchSummarySince: async () => ({ fired: 2, failed: 0 }),
    getInFlightLabelBatch: async () => null,
    getLabelCandidates: async () => [], // all caught up: the run is over
    getLabelsByRev: async () => [],
    getLabelAttempts: async () => new Map(),
    labelledSince: async (version, since) => {
      asked = { version, since };
      return [{ id: SNOWFLAKES[1], channelId: '504322272618610688' }];
    },
  });
  await step(new Date('2026-10-21T14:30:00Z')); // 10:30 Eastern
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(asked, { version: PROMPT_VERSION, since: runStart });
  assert.deepEqual(purgeReports, [[{ id: SNOWFLAKES[1], channelId: '504322272618610688' }]]);
});
