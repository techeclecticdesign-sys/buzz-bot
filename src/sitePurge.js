// Keeps rpc-web's signed-out cached pages current (its app/(site)/guest-view,
// kept up to a week). Changed advert rows are sent to rpc-web's
// POST /api/ads/purge, gathered for COALESCE_MS first so a burst is one call;
// rpc-web refreshes those ads' pages and the genre and fandom pages listing them.
// Once a day every genre and fandom page is purged as well: only the pages an ad
// is on now are known, so a page it left keeps listing it until then.
//
// Off unless RPC_WEB_URL and ADVERT_PURGE_SECRET (the same as rpc-web's) are set.
// Never throws: a call still failing after RETRIES tries is logged and dropped.
const advertConfig = require('./advertConfig');
const config = require('./config');

const COALESCE_MS = 45_000;
// Per call. rpc-web purges every genre and fandom page for more than 25 ids
// (its lib/topicPurge MAX_TARGETED_IDS), so a big batch goes in calls of 25.
const MAX_IDS = 25;
// rpc-web refuses a whole call with any other id.
const SNOWFLAKE = /^[0-9]{17,20}$/;
const RETRIES = 3;
const TIMEOUT_MS = 15_000;
const DAILY_CHECK_MS = 10 * 60 * 1000;

function createSitePurge({
  baseUrl,
  secret,
  advertChannels,
  // After the labeller's 8am US Eastern run.
  dailyHourUtc = 16,
  fetchImpl = fetch,
  now = () => new Date(),
  setTimer = (fn, ms) => setTimeout(fn, ms).unref(),
  clearTimer = (t) => clearTimeout(t),
  every = (fn, ms) => setInterval(fn, ms).unref(),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  retryDelayMs = 2000,
  log = console,
}) {
  const enabled = Boolean(baseUrl && secret);
  const channels = new Set(advertChannels);
  const pending = new Set();
  let timer = null;
  let queue = Promise.resolve(); // one call at a time, in order
  let dailyDate = null; // the UTC date of the last daily purge

  async function post(body) {
    const what = body.allTopics ? 'every genre/fandom page' : `${body.ids.length} advert(s)`;
    let delay = retryDelayMs;
    for (let attempt = 1; ; attempt++) {
      let failure;
      let refused = false;
      try {
        const res = await fetchImpl(`${baseUrl}/api/ads/purge`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        if (res.ok) {
          log.log(`[site-purge] purged ${what}.`);
          return true;
        }
        failure = `HTTP ${res.status}`;
        // A wrong secret or a bad request won't change on a retry.
        refused = res.status >= 400 && res.status < 500 && res.status !== 429;
      } catch (err) {
        failure = err.message;
      }
      if (refused || attempt >= RETRIES) {
        log.error(`[site-purge] couldn't purge ${what} (${attempt} attempt(s)): ${failure}`);
        return false;
      }
      await sleep(delay);
      delay *= 2;
    }
  }

  function enqueue(task) {
    queue = queue.then(task).catch((err) => log.error('[site-purge] failed:', err.message));
    return queue;
  }

  // Sends the pending ids now. Resolves once every call so far is done.
  function flush() {
    if (timer) clearTimer(timer);
    timer = null;
    const ids = [...pending];
    pending.clear();
    return enqueue(async () => {
      for (let i = 0; i < ids.length; i += MAX_IDS) await post({ ids: ids.slice(i, i + MAX_IDS) });
    });
  }

  // Rows a write changed ([{ id, channelId }]); only adverts matter to the site.
  function report(rows) {
    if (!enabled) return;
    for (const { id, channelId } of rows) {
      if (channels.has(channelId) && SNOWFLAKE.test(id)) pending.add(id);
    }
    if (pending.size && !timer) timer = setTimer(flush, COALESCE_MS);
  }

  function purgeAllTopics() {
    if (!enabled) return Promise.resolve();
    return enqueue(() => post({ allTopics: true }));
  }

  // Once a UTC day, from dailyHourUtc (on boot too, if that's past).
  function dailyTick() {
    const t = now();
    const date = t.toISOString().slice(0, 10);
    if (t.getUTCHours() < dailyHourUtc || dailyDate === date) return null;
    dailyDate = date;
    return purgeAllTopics();
  }

  function start() {
    if (!enabled) {
      log.log('[site-purge] off (RPC_WEB_URL / ADVERT_PURGE_SECRET unset).');
      return;
    }
    every(dailyTick, DAILY_CHECK_MS);
    dailyTick();
    log.log(
      `[site-purge] armed — ${baseUrl}: advert changes within ${COALESCE_MS / 1000}s, ` +
        `every genre/fandom page daily from ${dailyHourUtc}:00 UTC.`
    );
  }

  return { enabled, report, flush, start };
}

module.exports = createSitePurge({
  baseUrl: (process.env.RPC_WEB_URL || '').trim().replace(/\/+$/, ''),
  secret: (process.env.ADVERT_PURGE_SECRET || '').trim(),
  advertChannels: advertConfig.ALL_ADVERT_CHANNELS,
  dailyHourUtc: config.num('SITE_PURGE_DAILY_UTC_HOUR', 16, { min: 0, max: 23 }),
});
module.exports.createSitePurge = createSitePurge;
module.exports.COALESCE_MS = COALESCE_MS;
