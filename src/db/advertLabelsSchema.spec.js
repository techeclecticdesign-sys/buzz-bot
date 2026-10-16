// submit_advert_labels() against an in-memory Postgres (PGlite): the same SQL
// init() runs on the live DB, exercised as the routine calls it — role anon, the
// token in request.headers.
const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { initAdvertLabels, TABLES_SQL } = require('./advertLabelsSchema');

const TOKEN = 'test-labeller-token';
const VERSION = 'rpc14-v1';
// Snowflakes too big for a JS number: they must survive as strings.
const A = '1428390012345678901';
const B = '1428390012345678902';
const C = '1428390012345678903';

let db;

before(async () => {
  db = new PGlite();
  // Supabase's API roles, so the grants are real.
  await db.exec(`CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;`);
  // Simulate an existing install with labels but no age column yet.
  await db.exec(TABLES_SQL);
  await db.exec(`ALTER TABLE advert_labels DROP COLUMN author_age;
    INSERT INTO advert_labels (message_id, prompt_version, content_rev, labels, categories, firm_categories)
    VALUES ('legacy-age', '${VERSION}', 'legacy-rev', '[]', '{}', '{}');`);
  await initAdvertLabels((sql) => db.exec(sql));
  await initAdvertLabels((sql) => db.exec(sql)); // idempotent on a second boot
  const hash = createHash('sha256').update(TOKEN, 'utf8').digest('hex');
  await db.query('INSERT INTO advert_labeller_secret (id, token_sha256) VALUES (1, $1)', [hash]);
});

let seq = 0;
async function makeBatch(ids, { version = VERSION } = {}) {
  const batchId = `batch-${++seq}`;
  const items = ids.map((id) => ({ id, rev: `rev-${id}-${seq}` }));
  await db.query(
    'INSERT INTO advert_label_batches (batch_id, prompt_version, items) VALUES ($1, $2, $3)',
    [batchId, version, JSON.stringify(items)]
  );
  return { batchId, items };
}

// Call the function the way PostgREST does: as anon, headers in a GUC.
async function submit(payload, { token = TOKEN } = {}) {
  const headers = JSON.stringify(token === null ? {} : { 'x-labeller-token': token });
  await db.query("SELECT set_config('request.headers', $1, false)", [headers]);
  await db.exec('SET ROLE anon');
  try {
    const { rows } = await db.query('SELECT labeller_api.submit_advert_labels($1::jsonb) AS out', [
      JSON.stringify(payload),
    ]);
    return rows[0].out;
  } finally {
    await db.exec('RESET ROLE');
  }
}

async function labelRow(id) {
  const { rows } = await db.query(
    'SELECT * FROM advert_labels WHERE message_id = $1 AND prompt_version = $2',
    [id, VERSION]
  );
  return rows[0] ?? null;
}

async function batchRow(batchId) {
  const { rows } = await db.query('SELECT * FROM advert_label_batches WHERE batch_id = $1', [batchId]);
  return rows[0];
}

async function sqlState(promise) {
  try {
    await promise;
  } catch (err) {
    return err.code;
  }
  return null;
}

test('the migration adds an optional age to existing labels and enforces its range', async () => {
  const legacy = await labelRow('legacy-age');
  assert.equal(legacy.content_rev, 'legacy-rev');
  assert.equal(legacy.author_age, null);
  assert.equal(await sqlState(db.query(
    'UPDATE advert_labels SET author_age = $1 WHERE message_id = $2', [121, 'legacy-age']
  )), '23514');
});

test('author ages are optional, saved exactly, and cleared when no longer stated', async () => {
  const { batchId } = await makeBatch([A, B, C]);
  const payload = { batch_id: batchId, prompt_version: VERSION };
  const out = await submit({ ...payload, results: [
    { id: A, labels: [], author_age: 22 },
    { id: B, labels: [], author_age: null },
    { id: C, labels: [] }, // compatible with the old routine
  ] });
  assert.equal(out.accepted, 3);
  assert.deepEqual(out.rejected, []);
  assert.equal((await labelRow(A)).author_age, 22);
  assert.equal((await labelRow(B)).author_age, null);
  assert.equal((await labelRow(C)).author_age, null);

  await submit({ ...payload, results: [{ id: A, labels: [], author_age: 27 }] });
  assert.equal((await labelRow(A)).author_age, 27);
  await submit({ ...payload, results: [{ id: A, labels: [], author_age: null }] });
  assert.equal((await labelRow(A)).author_age, null);

  await submit({ ...payload, results: [
    { id: A, labels: [], author_age: 1 },
    { id: B, labels: [], author_age: 120 },
  ] });
  assert.equal((await labelRow(A)).author_age, 1);
  assert.equal((await labelRow(B)).author_age, 120);
});

test('invalid ages reject only their advert, with no coercion or partial write', async () => {
  const invalid = ['22', '25+', '', true, [], {}, 0, -1, 121, 22.5, 1e100];
  const ids = invalid.map((_, i) => String(1428390012345678904n + BigInt(i)));
  const { batchId } = await makeBatch([...ids, C]);
  const out = await submit({ batch_id: batchId, prompt_version: VERSION, results: [
    ...invalid.map((age, i) => ({ id: ids[i], labels: [['Fantasy', 0, 'magic']], author_age: age })),
    { id: C, labels: [], author_age: 27 },
  ] });
  assert.equal(out.accepted, 1);
  assert.deepEqual(out.missing, ids);
  assert.deepEqual(out.rejected, ids.map((id) => ({
    id, reason: 'author_age must be an integer from 1 to 120 or null',
  })));
  for (const id of ids) assert.equal(await labelRow(id), null);
  assert.equal((await labelRow(C)).author_age, 27);

  const fixed = await submit({ batch_id: batchId, prompt_version: VERSION,
    results: ids.map((id) => ({ id, labels: [], author_age: null })),
  });
  assert.equal(fixed.accepted, ids.length + 1);
  assert.deepEqual(fixed.missing, []);
});

test('repost inheritance reads and copies the self-stated age, including unknown', async (t) => {
  const { pool } = require('./pool');
  const { getLabelsByRev, inheritLabels } = require('./advertLabels');
  t.mock.method(pool, 'query', (sql, params) => db.query(sql, params));
  const { batchId, items } = await makeBatch([A]);
  await submit({ batch_id: batchId, prompt_version: VERSION,
    results: [{ id: A, labels: [['Fantasy', 0, 'magic']], author_age: 27 }],
  });
  const [source] = await getLabelsByRev(VERSION, [items[0].rev]);
  assert.equal(source.author_age, 27);
  await inheritLabels('age-repost', VERSION, items[0].rev, source);
  const inherited = await labelRow('age-repost');
  assert.equal(inherited.author_age, 27);
  assert.equal(inherited.inherited_from, A);
  assert.deepEqual(inherited.categories, ['Fantasy']);

  await inheritLabels('age-repost', VERSION, 'unknown-age-rev', { ...source, author_age: null });
  assert.equal((await labelRow('age-repost')).author_age, null);
});

test('a valid submission writes rows and finishes the batch', async () => {
  const { batchId, items } = await makeBatch([A, B]);
  const out = await submit({
    batch_id: batchId,
    prompt_version: VERSION,
    results: [
      { id: A, labels: [['Romantic', 1, 'romance optional'], ['Fantasy', 0, 'dragon kingdom']], fandoms: ['Harry Potter'] },
      { id: B, labels: [], fandoms: [] },
    ],
  });
  assert.deepEqual(out, { batch_id: batchId, accepted: 2, missing: [], rejected: [] });

  const a = await labelRow(A);
  assert.equal(a.content_rev, items[0].rev); // from the batch, never the payload
  // Canonical category order, whatever order the routine wrote.
  assert.deepEqual(a.labels, [['Fantasy', 0, 'dragon kingdom'], ['Romantic', 1, 'romance optional']]);
  assert.deepEqual(a.categories, ['Fantasy', 'Romantic']);
  assert.deepEqual(a.firm_categories, ['Fantasy']);
  assert.deepEqual(a.fandoms, ['Harry Potter']);
  assert.equal(a.batch_id, batchId);

  // An empty labels array is valid: labelled, no category.
  const b = await labelRow(B);
  assert.deepEqual(b.labels, []);
  assert.deepEqual(b.categories, []);

  const batch = await batchRow(batchId);
  assert.equal(batch.status, 'done');
  assert.equal(batch.accepted, 2);
  assert.ok(batch.completed_at);
});

test('a wrong or missing token raises 401 and writes nothing', async () => {
  const { batchId } = await makeBatch([C]);
  const payload = { batch_id: batchId, prompt_version: VERSION, results: [{ id: C, labels: [] }] };
  assert.equal(await sqlState(submit(payload, { token: 'nope' })), 'PT401');
  assert.equal(await sqlState(submit(payload, { token: null })), 'PT401');
  assert.equal((await batchRow(batchId)).status, 'sent');
});

test('an unknown batch is a 404 and a version mismatch a 400', async () => {
  const { batchId } = await makeBatch([C]);
  assert.equal(
    await sqlState(submit({ batch_id: 'no-such-batch', prompt_version: VERSION, results: [] })),
    'PT404'
  );
  assert.equal(
    await sqlState(submit({ batch_id: batchId, prompt_version: 'rpc99', results: [] })),
    'PT400'
  );
  assert.equal(await sqlState(submit({ batch_id: batchId, prompt_version: VERSION })), 'PT400');
});

test('an id not in the batch and an unknown category are rejected', async () => {
  const { batchId } = await makeBatch([A]);
  const out = await submit({
    batch_id: batchId,
    prompt_version: VERSION,
    results: [
      { id: '999', labels: [['Fantasy', 0, 'x']] },
      { id: A, labels: [['Steampunk', 0, 'gears'], ['Horror', 2, 'bad hedge'], ['Crime'], ['Crime', 0, 'heist']] },
    ],
  });
  assert.deepEqual(
    out.rejected.map((r) => [r.id, r.reason]),
    [
      ['999', 'id not in batch'],
      [A, 'unknown category'],
      [A, 'hedged must be 0 or 1'],
      [A, 'label is not [category, hedged, evidence]'],
    ]
  );
  assert.deepEqual((await labelRow(A)).categories, ['Crime']);
  assert.equal(out.accepted, 1);
});

test('labels are cleaned: evidence cut, duplicates merged (firm wins), Cyberpunk adds Sci-Fi', async () => {
  const { batchId } = await makeBatch([A]);
  await submit({
    batch_id: batchId,
    prompt_version: VERSION,
    results: [
      {
        id: A,
        labels: [
          ['NSFW', 1, 'open to it'],
          ['NSFW', 0, 'smut please'],
          ['Cyberpunk', 1, 'x'.repeat(150)],
        ],
      },
    ],
  });
  const a = await labelRow(A);
  assert.deepEqual(a.categories, ['Cyberpunk', 'Science Fiction', 'NSFW']);
  assert.deepEqual(a.firm_categories, ['NSFW']);
  const byCat = Object.fromEntries(a.labels.map((l) => [l[0], l]));
  assert.equal(byCat.NSFW[1], 0);
  assert.equal(byCat.Cyberpunk[2].length, 100);
  assert.equal(byCat['Science Fiction'][1], 1); // same hedge as Cyberpunk
});

test('fandoms are trimmed, de-duplicated case-insensitively, capped, and default to none', async () => {
  const { batchId } = await makeBatch([A, B]);
  const many = Array.from({ length: 50 }, (_, i) => `Fandom ${i}`);
  await submit({
    batch_id: batchId,
    prompt_version: VERSION,
    results: [
      { id: A, labels: [], fandoms: ['  Pokémon ', 'pokémon', '', '   ', 42, null, 'y'.repeat(90), ...many] },
      { id: B, labels: [] }, // no fandoms key
    ],
  });
  const a = await labelRow(A);
  assert.equal(a.fandoms[0], 'Pokémon');
  assert.equal(a.fandoms[1], 'y'.repeat(80));
  assert.equal(a.fandoms.length, 40);
  assert.deepEqual((await labelRow(B)).fandoms, []);
});

test('the same call twice gives the same rows', async () => {
  const { batchId } = await makeBatch([A, B]);
  const payload = {
    batch_id: batchId,
    prompt_version: VERSION,
    results: [
      { id: A, labels: [['Horror', 0, 'slasher']], fandoms: ['Scream'], author_age: 27 },
      { id: B, labels: [['Modern', 1, 'modern AU ok']] },
    ],
  };
  const first = await submit(payload);
  const rowsA = await labelRow(A);
  const second = await submit(payload);
  const rowsA2 = await labelRow(A);
  assert.deepEqual(second, first);
  for (const col of ['content_rev', 'labels', 'categories', 'firm_categories', 'fandoms', 'author_age', 'batch_id']) {
    assert.deepEqual(rowsA2[col], rowsA[col], col);
  }
});

test('ads left out make the batch partial; a later fix completes it', async () => {
  const { batchId } = await makeBatch([A, B, C]);
  const out = await submit({
    batch_id: batchId,
    prompt_version: VERSION,
    results: [{ id: A, labels: [] }],
  });
  assert.deepEqual(out.missing, [B, C]);
  assert.equal(out.accepted, 1);
  assert.equal((await batchRow(batchId)).status, 'partial');

  const fixed = await submit({
    batch_id: batchId,
    prompt_version: VERSION,
    results: [{ id: B, labels: [] }, { id: C, labels: [] }],
  });
  assert.deepEqual(fixed.missing, []);
  assert.equal(fixed.accepted, 3);
  assert.equal((await batchRow(batchId)).status, 'done');
});

test('an error payload fails the batch', async () => {
  const { batchId } = await makeBatch([A]);
  const out = await submit({ batch_id: batchId, prompt_version: VERSION, error: 'e'.repeat(600) });
  assert.deepEqual(out, { batch_id: batchId, status: 'failed' });
  const batch = await batchRow(batchId);
  assert.equal(batch.status, 'failed');
  assert.equal(batch.error.length, 500);
});

test('a late submission never overwrites labels written after its batch was sent', async () => {
  const old = await makeBatch([A]);
  const newer = await makeBatch([A]);
  await submit({ batch_id: newer.batchId, prompt_version: VERSION, results: [{ id: A, labels: [['SFW', 0, 'sfw only']], author_age: 27 }] });
  const out = await submit({ batch_id: old.batchId, prompt_version: VERSION, results: [{ id: A, labels: [['NSFW', 0, 'smut']], author_age: 22 }] });
  assert.deepEqual((await labelRow(A)).categories, ['SFW']);
  assert.equal((await labelRow(A)).author_age, 27);
  assert.equal(out.accepted, 0);
  assert.deepEqual(out.missing, [A]);
});

test('re-running the migration keeps every existing row', async () => {
  const count = async (table) => (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  const before = {
    batches: await count('advert_label_batches'),
    labels: await count('advert_labels'),
    secret: await count('advert_labeller_secret'),
  };
  assert.ok(before.batches > 0 && before.labels > 0 && before.secret === 1);
  const sample = await labelRow(A);
  await initAdvertLabels((sql) => db.exec(sql));
  assert.deepEqual(
    {
      batches: await count('advert_label_batches'),
      labels: await count('advert_labels'),
      secret: await count('advert_labeller_secret'),
    },
    before
  );
  assert.deepEqual(await labelRow(A), sample);
});

test('only anon may call the function, and nobody reads the tables through the API roles', async () => {
  const canExec = async (role) =>
    (await db.query(`SELECT has_function_privilege($1, 'labeller_api.submit_advert_labels(jsonb)', 'EXECUTE') AS ok`, [role])).rows[0].ok;
  assert.equal(await canExec('anon'), true);
  assert.equal(await canExec('authenticated'), false);
  assert.equal(await canExec('service_role'), false);
  // The schema holds the function alone, and only anon may use it.
  const { rows: schema } = await db.query(
    `SELECT has_schema_privilege('anon', 'labeller_api', 'USAGE') AS anon,
            has_schema_privilege('authenticated', 'labeller_api', 'USAGE') AS auth,
            (SELECT count(*)::int FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'labeller_api') AS relations,
            (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname = 'labeller_api') AS functions,
            to_regprocedure('public.submit_advert_labels(jsonb)') IS NULL AS old_public_gone`
  );
  assert.deepEqual(schema[0], { anon: true, auth: false, relations: 0, functions: 1, old_public_gone: true });
  for (const table of ['advert_labels', 'advert_label_batches', 'advert_labeller_secret']) {
    const { rows } = await db.query(
      `SELECT has_table_privilege('anon', $1, 'SELECT') AS anon, has_table_privilege('authenticated', $1, 'SELECT') AS auth`,
      [table]
    );
    assert.deepEqual(rows[0], { anon: false, auth: false }, table);
  }
});

test('retention prunes only old labels of gone adverts or retired prompts, and old finished batches', async () => {
  const { PRUNE_LABELS_SQL, PRUNE_BATCHES_SQL } = require('./advertLabels');
  await db.exec(`CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, deleted_at TIMESTAMPTZ)`);
  await db.exec(`INSERT INTO messages (id, deleted_at) VALUES ('m-live', NULL), ('m-deleted', now())`);
  const old = "now() - interval '100 days'";
  const add = (id, version, when) =>
    db.exec(`INSERT INTO advert_labels (message_id, prompt_version, content_rev, labels, categories, firm_categories, labelled_at)
             VALUES ('${id}', '${version}', 'r', '[]', '{}', '{}', ${when})`);
  await add('m-live', VERSION, old); //            standing advert: kept however old
  await add('m-deleted', VERSION, old); //         deleted on Discord, old: pruned
  await add('m-pruned', VERSION, old); //          row gone from messages, old: pruned
  await add('m-pruned-recent', VERSION, 'now()'); // gone but recent: kept (a repost may reuse it)
  await add('m-live', 'rpc13-v0', old); //         retired prompt version, old: pruned

  const cutoff = new Date(Date.now() - 90 * 24 * 3600 * 1000);
  const { affectedRows } = await db.query(PRUNE_LABELS_SQL, [cutoff, VERSION, 5000]);
  assert.equal(affectedRows, 3);
  const { rows } = await db.query(
    `SELECT message_id, prompt_version FROM advert_labels WHERE message_id LIKE 'm-%' ORDER BY 1, 2`
  );
  assert.deepEqual(rows, [
    { message_id: 'm-live', prompt_version: VERSION },
    { message_id: 'm-pruned-recent', prompt_version: VERSION },
  ]);

  // Batches: old finished ones go; their labels stay with batch_id NULL; a 'sent' one is never touched.
  await db.exec(`INSERT INTO advert_label_batches (batch_id, prompt_version, items, status, sent_at) VALUES
    ('old-done', '${VERSION}', '[]', 'done', ${old}),
    ('old-sent', '${VERSION}', '[]', 'sent', ${old}),
    ('new-done', '${VERSION}', '[]', 'done', now())`);
  await db.exec(`UPDATE advert_labels SET batch_id = 'old-done' WHERE message_id = 'm-live' AND prompt_version = '${VERSION}'`);
  const pruned = await db.query(PRUNE_BATCHES_SQL, [cutoff, 5000]);
  assert.equal(pruned.affectedRows, 1);
  const left = await db.query(`SELECT batch_id FROM advert_label_batches WHERE batch_id IN ('old-done','old-sent','new-done') ORDER BY 1`);
  assert.deepEqual(left.rows.map((r) => r.batch_id), ['new-done', 'old-sent']);
  const live = await db.query(`SELECT batch_id FROM advert_labels WHERE message_id = 'm-live' AND prompt_version = '${VERSION}'`);
  assert.equal(live.rows[0].batch_id, null);
});
