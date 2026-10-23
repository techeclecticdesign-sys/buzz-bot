// Queries for the AI advert labeller (advertLabeller.js). The schema and the
// submit_advert_labels() RPC the routine writes through are in
// advertLabelsSchema.js; nothing here reads or writes the token itself.
const { query } = require('./pool');

// Store the labeller token's sha256 hex (what the RPC compares against).
async function setLabellerTokenHash(sha256Hex) {
  await query(
    `INSERT INTO advert_labeller_secret (id, token_sha256) VALUES (1, $1)
     ON CONFLICT (id) DO UPDATE SET token_sha256 = EXCLUDED.token_sha256, updated_at = now()
       WHERE advert_labeller_secret.token_sha256 IS DISTINCT FROM EXCLUDED.token_sha256`,
    [sha256Hex]
  );
}

// 'sent' batches older than staleHours never got their submission: expire them.
async function expireStaleLabelBatches(staleHours) {
  const { rows } = await query(
    `UPDATE advert_label_batches SET status = 'expired', completed_at = now()
      WHERE status = 'sent' AND sent_at < now() - make_interval(hours => $1)
      RETURNING batch_id`,
    [staleHours]
  );
  return rows.map((r) => r.batch_id);
}

// The batch still waiting on the routine, or null.
async function getInFlightLabelBatch() {
  const { rows } = await query(
    `SELECT batch_id, sent_at FROM advert_label_batches
      WHERE status = 'sent' ORDER BY sent_at DESC LIMIT 1`
  );
  return rows[0] ?? null;
}

// Batches sent since `since`: how many, and how many ended failed or expired.
async function labelBatchSummarySince(since) {
  const { rows } = await query(
    `SELECT count(*)::int AS fired,
            count(*) FILTER (WHERE status IN ('failed', 'expired'))::int AS failed
       FROM advert_label_batches WHERE sent_at >= $1`,
    [since]
  );
  return rows[0];
}

// Standing adverts in `channelIds` posted before `before` that may need labels:
// no row for this prompt version yet, or edited since (the caller compares the
// current text's rev with labelled_rev). Newest first.
async function getLabelCandidates(channelIds, promptVersion, before) {
  const { rows } = await query(
    `SELECT m.id, m.content, l.content_rev AS labelled_rev
       FROM messages m
       LEFT JOIN advert_labels l ON l.message_id = m.id AND l.prompt_version = $2
      WHERE m.channel_id = ANY($1::text[])
        AND m.deleted_at IS NULL
        AND m.created_at < $3
        AND btrim(coalesce(m.content, '')) <> ''
        AND (l.message_id IS NULL OR m.edited_at IS NOT NULL)
      ORDER BY m.created_at DESC`,
    [channelIds, promptVersion, before]
  );
  return rows;
}

// Labels already written for any of these revs (newest per rev): the same text
// posted again — a repost, a bump, an edit back — reuses them.
async function getLabelsByRev(promptVersion, revs) {
  if (!revs.length) return [];
  const { rows } = await query(
    `SELECT DISTINCT ON (content_rev)
            message_id, content_rev, labels, categories, firm_categories, fandoms, author_age
       FROM advert_labels
      WHERE prompt_version = $1 AND content_rev = ANY($2::text[])
      ORDER BY content_rev, labelled_at DESC`,
    [promptVersion, revs]
  );
  return rows;
}

// Copy `source`'s labels onto a message whose text has the same rev.
async function inheritLabels(messageId, promptVersion, rev, source) {
  await query(
    `INSERT INTO advert_labels
       (message_id, prompt_version, content_rev, labels, categories, firm_categories,
        fandoms, author_age, batch_id, inherited_from, labelled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NULL, $9, now())
     ON CONFLICT (message_id, prompt_version) DO UPDATE
       SET content_rev = EXCLUDED.content_rev,
           labels = EXCLUDED.labels,
           categories = EXCLUDED.categories,
           firm_categories = EXCLUDED.firm_categories,
           fandoms = EXCLUDED.fandoms,
           author_age = EXCLUDED.author_age,
           batch_id = NULL,
           inherited_from = EXCLUDED.inherited_from,
           labelled_at = now()`,
    [
      messageId,
      promptVersion,
      rev,
      JSON.stringify(source.labels),
      source.categories,
      source.firm_categories,
      source.fandoms,
      source.author_age ?? null,
      source.message_id,
    ]
  );
}

// id → how many batches the routine ran but left this ad unlabelled in: failed
// batches it reached (they have a session) and partial batches listing it missing.
// Fires that never reached the routine, and expired batches, don't count.
async function getLabelAttempts(promptVersion, ids) {
  if (!ids.length) return new Map();
  const { rows } = await query(
    `SELECT i ->> 'id' AS id, count(*)::int AS n
       FROM advert_label_batches b
       CROSS JOIN LATERAL jsonb_array_elements(b.items) i
      WHERE b.prompt_version = $1
        AND i ->> 'id' = ANY($2::text[])
        AND ((b.status = 'failed' AND b.session_id IS NOT NULL)
          OR (b.status = 'partial' AND b.missing ? (i ->> 'id')))
      GROUP BY 1`,
    [promptVersion, ids]
  );
  return new Map(rows.map((r) => [r.id, r.n]));
}

// Record a batch as sent, BEFORE firing, so the routine can find it.
async function insertLabelBatch(batchId, promptVersion, items) {
  await query(
    `INSERT INTO advert_label_batches (batch_id, prompt_version, items, status)
     VALUES ($1, $2, $3, 'sent')`,
    [batchId, promptVersion, JSON.stringify(items)]
  );
}

async function recordLabelFire(batchId, sessionId, sessionUrl) {
  await query(
    'UPDATE advert_label_batches SET session_id = $2, session_url = $3 WHERE batch_id = $1',
    [batchId, sessionId, sessionUrl]
  );
}

async function getLabelBatch(batchId) {
  const { rows } = await query(
    `SELECT batch_id, status, accepted, jsonb_array_length(items) AS ads, error
       FROM advert_label_batches WHERE batch_id = $1`,
    [batchId]
  );
  return rows[0] ?? null;
}

// A batch the routine never submitted (given up on): its ads become eligible again.
async function expireLabelBatch(batchId) {
  await query(
    `UPDATE advert_label_batches SET status = 'expired', completed_at = now()
      WHERE batch_id = $1 AND status = 'sent'`,
    [batchId]
  );
}

// A fire that failed: its ads become eligible again (next run).
async function failLabelBatch(batchId, error) {
  await query(
    `UPDATE advert_label_batches
        SET status = 'failed', error = left($2, 500), completed_at = now()
      WHERE batch_id = $1 AND status = 'sent'`,
    [batchId, error]
  );
}

// --- Same-fandom report (fandomReport.js) ---
// Pairs of standing adverts by one poster in `channelIds` that share a fandom,
// where at least one of the two was labelled in ($3, $4]. Fandoms match ignoring
// case, spaces and punctuation. One row per pair: new_* is the later post.
const SAME_FANDOM_SQL = `
  WITH ads AS (
    SELECT m.id, m.channel_id, m.author_id,
           coalesce(m.created_at, 'epoch') AS created_at,
           l.labelled_at > $3 AND l.labelled_at <= $4 AS fresh,
           ARRAY(SELECT DISTINCT k
                   FROM unnest(l.fandoms) AS f,
                        LATERAL regexp_replace(lower(f), '[^[:alnum:]]+', '', 'g') AS k
                  WHERE k <> '') AS keys
      FROM advert_labels l
      JOIN messages m ON m.id = l.message_id
     WHERE l.prompt_version = $1
       AND m.channel_id = ANY($2::text[])
       AND m.deleted_at IS NULL
       AND m.author_id IS NOT NULL
       AND cardinality(l.fandoms) > 0
  )
  SELECT n.author_id, n.id AS new_id, n.channel_id AS new_channel_id,
         o.id AS old_id, o.channel_id AS old_channel_id
    FROM ads n
    JOIN ads o ON o.author_id = n.author_id
              AND (o.created_at, o.id) < (n.created_at, n.id)
              AND o.keys && n.keys
   WHERE n.fresh OR o.fresh
   ORDER BY n.author_id, n.created_at, n.id, o.created_at, o.id`;

async function findSameFandomPairs(promptVersion, channelIds, since, until) {
  const { rows } = await query(SAME_FANDOM_SQL, [promptVersion, channelIds, since, until]);
  return rows;
}

// Claim `runDate`'s report: it covers from where the last one ended (or
// `firstSince`) to now. Null when that day's report is already claimed.
const CLAIM_FANDOM_REPORT_SQL = `
  INSERT INTO advert_fandom_reports (run_date, covered_from, covered_until)
  SELECT $1::date, coalesce((SELECT max(covered_until) FROM advert_fandom_reports), $2), now()
  ON CONFLICT (run_date) DO NOTHING
  RETURNING covered_from, covered_until`;

async function claimFandomReport(runDate, firstSince) {
  const { rows } = await query(CLAIM_FANDOM_REPORT_SQL, [runDate, firstSince]);
  return rows[0] ?? null;
}

async function completeFandomReport(runDate, pairs) {
  await query(
    'UPDATE advert_fandom_reports SET pairs = $2, posted_at = now() WHERE run_date = $1::date',
    [runDate, pairs]
  );
}

// The post failed: drop the claim so the window rolls into the next report.
async function releaseFandomReport(runDate) {
  await query('DELETE FROM advert_fandom_reports WHERE run_date = $1::date AND posted_at IS NULL', [runDate]);
}

// --- Retention (run by retention.js) ---
// Labels outlive their advert on purpose, so a repost of the same text reuses
// them; this bounds how long. A label goes once its advert is gone (deleted on
// Discord or pruned from messages) and it's older than the cutoff, and so does
// every label of a prompt version that's no longer current. Finished batches
// (just a log of fires) go after the cutoff too; their labels stay (the FK sets
// batch_id NULL). Batched via ctid, like the message prunes.
const PRUNE_LABELS_SQL = `
  DELETE FROM advert_labels WHERE ctid IN (
    SELECT l.ctid FROM advert_labels l
     WHERE l.labelled_at < $1
       AND (l.prompt_version <> $2
            OR NOT EXISTS (SELECT 1 FROM messages m
                            WHERE m.id = l.message_id AND m.deleted_at IS NULL))
     LIMIT $3)`;

const PRUNE_BATCHES_SQL = `
  DELETE FROM advert_label_batches WHERE ctid IN (
    SELECT ctid FROM advert_label_batches
     WHERE status <> 'sent' AND sent_at < $1
     LIMIT $2)`;

async function pruneAdvertLabels(cutoff, currentPromptVersion, limit = 5000) {
  const res = await query(PRUNE_LABELS_SQL, [cutoff, currentPromptVersion, limit]);
  return res.rowCount;
}

async function pruneLabelBatches(cutoff, limit = 5000) {
  const res = await query(PRUNE_BATCHES_SQL, [cutoff, limit]);
  return res.rowCount;
}

// The latest batches, for `--status`.
async function recentLabelBatches(limit = 10) {
  const { rows } = await query(
    `SELECT batch_id, status, sent_at, completed_at, jsonb_array_length(items) AS ads,
            accepted, jsonb_array_length(coalesce(missing, '[]'::jsonb)) AS missing,
            jsonb_array_length(coalesce(rejected, '[]'::jsonb)) AS rejected,
            session_url, error
       FROM advert_label_batches ORDER BY sent_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

// The stored adverts labelled (by the routine, or inherited) since `since`, as
// [{ id, channelId }]: a run's new labels, for sitePurge.
async function labelledSince(promptVersion, since) {
  const { rows } = await query(
    `SELECT m.id, m.channel_id FROM advert_labels l
       JOIN messages m ON m.id = l.message_id
      WHERE l.prompt_version = $1 AND l.labelled_at >= $2`,
    [promptVersion, since]
  );
  return rows.map((r) => ({ id: r.id, channelId: r.channel_id }));
}

module.exports = {
  labelledSince,
  setLabellerTokenHash,
  expireStaleLabelBatches,
  getInFlightLabelBatch,
  labelBatchSummarySince,
  getLabelCandidates,
  getLabelsByRev,
  inheritLabels,
  getLabelAttempts,
  insertLabelBatch,
  recordLabelFire,
  getLabelBatch,
  expireLabelBatch,
  failLabelBatch,
  recentLabelBatches,
  findSameFandomPairs,
  claimFandomReport,
  completeFandomReport,
  releaseFandomReport,
  SAME_FANDOM_SQL,
  CLAIM_FANDOM_REPORT_SQL,
  pruneAdvertLabels,
  pruneLabelBatches,
  PRUNE_LABELS_SQL,
  PRUNE_BATCHES_SQL,
};
