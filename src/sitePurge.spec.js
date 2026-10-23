const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSitePurge, COALESCE_MS } = require('./sitePurge');

const ADVERT = '504322272618610688';
const CHAT = '300829309214523392';
const id = (n) => String(1428390012345678000n + BigInt(n)); // snowflake-shaped

// A sitePurge with a hand-run clock: timers fire only when the test says so, and
// retries don't wait.
function harness({ responses = [], hour = 12, ...opts } = {}) {
  const calls = [];
  const errors = [];
  const timers = [];
  let intervals = [];
  let clock = new Date(Date.UTC(2026, 9, 23, hour));
  const purge = createSitePurge({
    baseUrl: 'https://rpc.test',
    secret: 'secret',
    advertChannels: [ADVERT],
    dailyHourUtc: 16,
    fetchImpl: async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization, body: JSON.parse(init.body) });
      const next = responses.shift() ?? 200;
      if (next instanceof Error) throw next;
      return { ok: next < 300, status: next };
    },
    now: () => clock,
    setTimer: (fn, ms) => {
      const t = { fn, ms };
      timers.push(t);
      return t;
    },
    clearTimer: (t) => timers.splice(timers.indexOf(t), 1),
    every: (fn, ms) => intervals.push({ fn, ms }),
    sleep: async () => {},
    log: { log() {}, error: (...args) => errors.push(args.join(' ')) },
    ...opts,
  });
  return {
    purge,
    calls,
    errors,
    timers,
    get intervals() {
      return intervals;
    },
    setHour(date, h) {
      clock = new Date(`${date}T${String(h).padStart(2, '0')}:00:00Z`);
    },
    // Fire the pending coalesce timer, as the clock would after COALESCE_MS.
    async elapse() {
      const t = timers.shift();
      assert.ok(t, 'a timer should be pending');
      assert.equal(t.ms, COALESCE_MS);
      await t.fn();
    },
  };
}

const row = (id, channelId = ADVERT) => ({ id, channelId });

test('advert changes are gathered into one call per window, deduped, chat ignored', async () => {
  const h = harness();
  h.purge.report([row(id(1)), row(id(2))]);
  h.purge.report([row(id(2)), row(id(3), CHAT), row('not-a-snowflake')]);
  h.purge.report([row(id(4))]);
  assert.equal(h.timers.length, 1, 'one window, not one per report');
  assert.equal(h.calls.length, 0, 'nothing sent before the window ends');

  await h.elapse();
  assert.deepEqual(h.calls, [
    { url: 'https://rpc.test/api/ads/purge', auth: 'Bearer secret', body: { ids: [id(1), id(2), id(4)] } },
  ]);

  // Chat alone starts no window.
  h.purge.report([row(id(5), CHAT)]);
  assert.equal(h.timers.length, 0);
});

test('more than 25 ids go in calls of 25, so each stays a targeted purge', async () => {
  const h = harness();
  h.purge.report(Array.from({ length: 60 }, (_, i) => row(id(i))));
  await h.elapse();
  assert.deepEqual(h.calls.map((c) => c.body.ids.length), [25, 25, 10]);
});

test('a failing call is retried up to three times, then dropped without throwing', async () => {
  const h = harness({ responses: [500, new Error('ECONNRESET'), 200] });
  h.purge.report([row(id(1))]);
  await h.elapse();
  assert.equal(h.calls.length, 3);
  assert.deepEqual(h.errors, []);

  const g = harness({ responses: [502, 502, 502, 502] });
  g.purge.report([row(id(1))]);
  await g.elapse();
  assert.equal(g.calls.length, 3);
  assert.match(g.errors[0], /couldn't purge 1 advert\(s\) \(3 attempt\(s\)\): HTTP 502/);
});

test('a refusal is not retried', async () => {
  const h = harness({ responses: [401] });
  h.purge.report([row(id(1))]);
  await h.elapse();
  assert.equal(h.calls.length, 1);
  assert.match(h.errors[0], /HTTP 401/);
});

test('flush sends what is pending at once and waits for it', async () => {
  const h = harness();
  h.purge.report([row(id(1))]);
  await h.purge.flush();
  assert.deepEqual(h.calls.map((c) => c.body), [{ ids: [id(1)] }]);
  assert.equal(h.timers.length, 0, 'the window is cancelled');
  await h.purge.flush(); // nothing pending: no call
  assert.equal(h.calls.length, 1);
});

test('unconfigured, it does nothing', async () => {
  const h = harness({ baseUrl: '' });
  assert.equal(h.purge.enabled, false);
  h.purge.report([row(id(1))]);
  h.purge.start();
  await h.purge.flush();
  assert.equal(h.timers.length, 0);
  assert.equal(h.intervals.length, 0);
  assert.equal(h.calls.length, 0);
});

test('every genre and fandom page is purged once a day from the set hour, on its own timer', async () => {
  const h = harness();
  h.setHour('2026-10-23', 15);
  h.purge.start(); // the labeller plays no part: this runs whether or not it's on
  assert.equal(h.intervals.length, 1);
  const tick = h.intervals[0].fn;
  await h.purge.flush();
  assert.equal(h.calls.length, 0, 'not before the hour');

  h.setHour('2026-10-23', 16);
  await tick();
  h.setHour('2026-10-23', 23);
  await tick();
  await h.purge.flush();
  assert.deepEqual(h.calls.map((c) => c.body), [{ allTopics: true }], 'once that day');

  h.setHour('2026-10-24', 16);
  await tick();
  await h.purge.flush();
  assert.deepEqual(h.calls.map((c) => c.body), [{ allTopics: true }, { allTopics: true }], 'again the next day');
});

test('a boot after the hour purges that day at once', async () => {
  const h = harness({ hour: 18 });
  h.purge.start();
  await h.purge.flush();
  assert.deepEqual(h.calls.map((c) => c.body), [{ allTopics: true }]);
});
