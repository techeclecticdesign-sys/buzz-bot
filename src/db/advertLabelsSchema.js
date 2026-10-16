// Schema for the AI advert labeller (see src/advertLabeller.js): the batches the
// bot sends to the Claude Code routine, the labels the routine writes back, the
// labeller token's hash, and labeller_api.submit_advert_labels() — the ONE way
// the routine touches this database (PostgREST RPC, as role anon). Kept out of
// migrate.js because the function body is long; init() calls initAdvertLabels(),
// and the spec runs the same SQL against an in-memory Postgres.
//
// The function lives alone in its own schema, labeller_api, and that is the only
// schema the Supabase Data API exposes: nothing in public is reachable through
// the API. The tables are closed besides (RLS on, no policies, every grant to
// anon/authenticated revoked). The bot and rpc-web connect as the owner and are
// unaffected.

// The routine's 14 categories (prompt rpc14-v1), in display order. The function
// writes labels in this order so a repeated submission gives identical rows.
const CATEGORIES = [
  'Crime',
  'Cyberpunk',
  'Fantasy',
  'Historical',
  'Horror',
  'Modern',
  'Post Apocalyptic',
  'Science Fiction',
  'Slice of Life',
  'Supernatural',
  'Romantic',
  'Platonic',
  'NSFW',
  'SFW',
];

const CATEGORY_ARRAY_SQL = `ARRAY[${CATEGORIES.map((c) => `'${c}'`).join(', ')}]::text[]`;

const TABLES_SQL = `
  -- One row per fire. items = every ad sent plus its content rev at send time
  -- ([{"id","rev"}]); the function takes content_rev from here, never the payload.
  CREATE TABLE IF NOT EXISTS advert_label_batches (
    batch_id       TEXT PRIMARY KEY,
    prompt_version TEXT NOT NULL,
    items          JSONB NOT NULL,
    status         TEXT NOT NULL DEFAULT 'sent'
                   CHECK (status IN ('sent', 'done', 'partial', 'failed', 'expired')),
    session_id     TEXT,
    session_url    TEXT,
    sent_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at   TIMESTAMPTZ,
    accepted       INT,
    missing        JSONB,
    rejected       JSONB,
    error          TEXT
  );
  CREATE INDEX IF NOT EXISTS advert_label_batches_status_idx
    ON advert_label_batches (status, sent_at);

  -- One row per ad per prompt version. No FK to messages on purpose: a row
  -- outlives its message (retention prunes deleted posts after ~8 days), so a
  -- later repost of the same text inherits these labels instead of being sent
  -- again. inherited_from = the message whose labels a repost copied (NULL when
  -- the routine labelled this message itself).
  CREATE TABLE IF NOT EXISTS advert_labels (
    message_id      TEXT NOT NULL,
    prompt_version  TEXT NOT NULL,
    content_rev     TEXT NOT NULL,
    labels          JSONB NOT NULL,
    categories      TEXT[] NOT NULL,
    firm_categories TEXT[] NOT NULL,
    fandoms         TEXT[] NOT NULL DEFAULT '{}',
    author_age      INT CHECK (author_age BETWEEN 1 AND 120),
    batch_id        TEXT REFERENCES advert_label_batches(batch_id) ON DELETE SET NULL,
    inherited_from  TEXT,
    labelled_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (message_id, prompt_version),
    CONSTRAINT advert_labels_categories_check
      CHECK (categories <@ ${CATEGORY_ARRAY_SQL} AND firm_categories <@ categories)
  );
  -- Existing installs predate age extraction. NULL means no exact author age
  -- was identified (or the older routine did not extract it).
  ALTER TABLE advert_labels ADD COLUMN IF NOT EXISTS
    author_age INT CHECK (author_age BETWEEN 1 AND 120);
  CREATE INDEX IF NOT EXISTS advert_labels_categories_idx ON advert_labels USING GIN (categories);
  CREATE INDEX IF NOT EXISTS advert_labels_fandoms_idx ON advert_labels USING GIN (fandoms);
  -- Repost lookup: which labelled text has this rev?
  CREATE INDEX IF NOT EXISTS advert_labels_rev_idx ON advert_labels (prompt_version, content_rev);

  -- sha256 hex of LABELLER_TOKEN (the routine's x-labeller-token). The bot
  -- writes it at boot from its own env; the token itself never enters SQL.
  CREATE TABLE IF NOT EXISTS advert_labeller_secret (
    id           INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    token_sha256 TEXT NOT NULL,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  -- One row per day's same-fandom report (fandomReport.js), claimed before it's
  -- posted so a restart can't post the day twice. Each report covers labels
  -- written in (covered_from, covered_until]; the next one starts where it ended.
  CREATE TABLE IF NOT EXISTS advert_fandom_reports (
    run_date      DATE PRIMARY KEY,
    covered_from  TIMESTAMPTZ NOT NULL,
    covered_until TIMESTAMPTZ NOT NULL,
    pairs         INT,
    posted_at     TIMESTAMPTZ
  );

  ALTER TABLE advert_label_batches ENABLE ROW LEVEL SECURITY;
  ALTER TABLE advert_labels ENABLE ROW LEVEL SECURITY;
  ALTER TABLE advert_labeller_secret ENABLE ROW LEVEL SECURITY;
  ALTER TABLE advert_fandom_reports ENABLE ROW LEVEL SECURITY;
`;

// The API's schema. The function first shipped in public (2026-10-11); it moved
// here so the Data API can expose this schema alone. Dropping the old one drops
// no data.
const API_SCHEMA_SQL = `
  CREATE SCHEMA IF NOT EXISTS labeller_api;
  DROP FUNCTION IF EXISTS public.submit_advert_labels(jsonb);
`;

// PostgREST turns SQLSTATE PTxyz into HTTP status xyz, so the routine sees 401 /
// 404 / 400 (all "do not retry" in its prompt). Any raise rolls the call back.
const FUNCTION_SQL = `
CREATE OR REPLACE FUNCTION labeller_api.submit_advert_labels(payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $fn$
DECLARE
  cats CONSTANT text[] := ${CATEGORY_ARRAY_SQL};
  headers   json;
  token     text;
  want      text;
  b         public.advert_label_batches%ROWTYPE;
  revs      jsonb;
  r         jsonb;
  rid       text;
  lab       jsonb;
  cat       text;
  hedge     int;
  evidence  text;
  merged    jsonb;
  fandom_in jsonb;
  out_labels  jsonb;
  out_cats    text[];
  out_firm    text[];
  out_fandoms text[];
  out_author_age int;
  v_rejected jsonb := '[]'::jsonb;
  v_missing  jsonb;
  n_missing  int;
  n_done     int;
BEGIN
  -- 1. The labeller token, compared by hash.
  BEGIN
    headers := nullif(current_setting('request.headers', true), '')::json;
  EXCEPTION WHEN others THEN
    headers := NULL;
  END;
  token := headers ->> 'x-labeller-token';
  SELECT s.token_sha256 INTO want FROM public.advert_labeller_secret s WHERE s.id = 1;
  IF token IS NULL OR want IS NULL
     OR encode(sha256(convert_to(token, 'UTF8')), 'hex') <> want THEN
    RAISE EXCEPTION 'invalid labeller token' USING ERRCODE = 'PT401';
  END IF;

  -- 2. The batch. Late submissions are fine: any status is accepted.
  IF jsonb_typeof(payload) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'payload must be a JSON object' USING ERRCODE = 'PT400';
  END IF;
  SELECT * INTO b FROM public.advert_label_batches x
   WHERE x.batch_id = payload ->> 'batch_id'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'unknown batch_id' USING ERRCODE = 'PT404';
  END IF;
  IF payload ->> 'prompt_version' IS DISTINCT FROM b.prompt_version THEN
    RAISE EXCEPTION 'prompt_version does not match the batch (%)', b.prompt_version
      USING ERRCODE = 'PT400';
  END IF;

  -- 3. The routine could not label the batch. A batch already done keeps its status.
  IF payload ? 'error' THEN
    UPDATE public.advert_label_batches
       SET status = CASE WHEN status = 'done' THEN status ELSE 'failed' END,
           error = left(coalesce(payload ->> 'error', ''), 500),
           completed_at = now()
     WHERE batch_id = b.batch_id;
    RETURN jsonb_build_object('batch_id', b.batch_id, 'status', 'failed');
  END IF;

  IF jsonb_typeof(payload -> 'results') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'results must be a list' USING ERRCODE = 'PT400';
  END IF;

  -- id -> rev for every ad this batch sent.
  SELECT coalesce(jsonb_object_agg(i ->> 'id', i ->> 'rev'), '{}'::jsonb)
    INTO revs FROM jsonb_array_elements(b.items) i;

  -- 4. Each result.
  FOR r IN SELECT * FROM jsonb_array_elements(payload -> 'results') LOOP
    IF jsonb_typeof(r) IS DISTINCT FROM 'object' THEN
      v_rejected := v_rejected || jsonb_build_object('id', NULL, 'reason', 'result is not an object');
      CONTINUE;
    END IF;
    rid := r ->> 'id';
    IF rid IS NULL OR NOT revs ? rid THEN
      v_rejected := v_rejected || jsonb_build_object('id', rid, 'reason', 'id not in batch');
      CONTINUE;
    END IF;
    IF r ? 'labels' AND jsonb_typeof(r -> 'labels') IS DISTINCT FROM 'array' THEN
      v_rejected := v_rejected || jsonb_build_object('id', rid, 'reason', 'labels is not a list');
      CONTINUE;
    END IF;

    -- Optional exact, self-stated author age. Never coerce strings, round a
    -- fraction, or clamp a range. Older routines can omit it; NULL means unknown.
    out_author_age := NULL;
    IF r ? 'author_age' AND jsonb_typeof(r -> 'author_age') <> 'null' THEN
      IF jsonb_typeof(r -> 'author_age') IS DISTINCT FROM 'number' THEN
        v_rejected := v_rejected || jsonb_build_object('id', rid, 'reason', 'author_age must be an integer from 1 to 120 or null');
        CONTINUE;
      END IF;
      IF (r ->> 'author_age')::numeric NOT BETWEEN 1 AND 120
         OR (r ->> 'author_age')::numeric <> trunc((r ->> 'author_age')::numeric) THEN
        v_rejected := v_rejected || jsonb_build_object('id', rid, 'reason', 'author_age must be an integer from 1 to 120 or null');
        CONTINUE;
      END IF;
      out_author_age := (r ->> 'author_age')::numeric::int;
    END IF;

    -- Labels: category -> [hedged, evidence], merging duplicates (firm wins).
    merged := '{}'::jsonb;
    FOR lab IN SELECT * FROM jsonb_array_elements(coalesce(r -> 'labels', '[]'::jsonb)) LOOP
      IF jsonb_typeof(lab) IS DISTINCT FROM 'array' OR jsonb_array_length(lab) <> 3 THEN
        v_rejected := v_rejected || jsonb_build_object('id', rid, 'reason', 'label is not [category, hedged, evidence]', 'label', lab);
        CONTINUE;
      END IF;
      cat := CASE WHEN jsonb_typeof(lab -> 0) = 'string' THEN lab ->> 0 END;
      IF cat IS NULL OR NOT cat = ANY (cats) THEN
        v_rejected := v_rejected || jsonb_build_object('id', rid, 'reason', 'unknown category', 'label', lab);
        CONTINUE;
      END IF;
      IF jsonb_typeof(lab -> 1) IS DISTINCT FROM 'number' OR (lab -> 1) NOT IN ('0'::jsonb, '1'::jsonb) THEN
        v_rejected := v_rejected || jsonb_build_object('id', rid, 'reason', 'hedged must be 0 or 1', 'label', lab);
        CONTINUE;
      END IF;
      hedge := (lab ->> 1)::numeric::int;
      evidence := left(CASE WHEN jsonb_typeof(lab -> 2) = 'null' THEN '' ELSE lab ->> 2 END, 100);
      IF NOT merged ? cat OR (hedge = 0 AND (merged -> cat ->> 0)::int = 1) THEN
        merged := merged || jsonb_build_object(cat, jsonb_build_array(hedge, evidence));
      END IF;
    END LOOP;
    -- Cyberpunk always implies Science Fiction, with the same hedge.
    IF merged ? 'Cyberpunk' AND NOT merged ? 'Science Fiction' THEN
      merged := merged || jsonb_build_object('Science Fiction', merged -> 'Cyberpunk');
    END IF;

    SELECT coalesce(jsonb_agg(jsonb_build_array(c, (merged -> c ->> 0)::int, merged -> c ->> 1) ORDER BY o), '[]'::jsonb),
           coalesce(array_agg(c ORDER BY o), '{}'),
           coalesce(array_agg(c ORDER BY o) FILTER (WHERE (merged -> c ->> 0)::int = 0), '{}')
      INTO out_labels, out_cats, out_firm
      FROM unnest(cats) WITH ORDINALITY AS u(c, o)
     WHERE merged ? c;

    -- Fandoms: trimmed strings, blanks dropped, <= 80 chars, case-insensitive
    -- duplicates removed (first spelling kept), at most 40. Missing = none.
    fandom_in := r -> 'fandoms';
    IF fandom_in IS NOT NULL AND jsonb_typeof(fandom_in) NOT IN ('array', 'null') THEN
      v_rejected := v_rejected || jsonb_build_object('id', rid, 'reason', 'fandoms is not a list');
    END IF;
    IF jsonb_typeof(fandom_in) IS DISTINCT FROM 'array' THEN
      fandom_in := '[]'::jsonb;
    END IF;
    SELECT coalesce(array_agg(f ORDER BY o), '{}') INTO out_fandoms
      FROM (
        SELECT f, o FROM (
          SELECT DISTINCT ON (lower(f)) f, o
            FROM (
              SELECT btrim(left(btrim(e #>> '{}', E' \\t\\r\\n'), 80), E' \\t\\r\\n') AS f, o
                FROM jsonb_array_elements(fandom_in) WITH ORDINALITY AS x(e, o)
               WHERE jsonb_typeof(e) = 'string'
            ) cleaned
           WHERE f <> ''
           ORDER BY lower(f), o
        ) deduped
        ORDER BY o
        LIMIT 40
      ) kept;

    -- content_rev comes from the batch, never the payload. A late submission
    -- doesn't overwrite labels written after this batch was sent (e.g. for an
    -- edited ad's newer text).
    INSERT INTO public.advert_labels AS l
      (message_id, prompt_version, content_rev, labels, categories, firm_categories,
       fandoms, author_age, batch_id, inherited_from, labelled_at)
    VALUES
      (rid, b.prompt_version, revs ->> rid, out_labels, out_cats, out_firm,
       out_fandoms, out_author_age, b.batch_id, NULL, now())
    ON CONFLICT (message_id, prompt_version) DO UPDATE
      SET content_rev = EXCLUDED.content_rev,
          labels = EXCLUDED.labels,
          categories = EXCLUDED.categories,
          firm_categories = EXCLUDED.firm_categories,
          fandoms = EXCLUDED.fandoms,
          author_age = EXCLUDED.author_age,
          batch_id = EXCLUDED.batch_id,
          inherited_from = NULL,
          labelled_at = EXCLUDED.labelled_at
      WHERE l.batch_id IS NOT DISTINCT FROM EXCLUDED.batch_id
         OR l.labelled_at < b.sent_at;
  END LOOP;

  -- 5. Ads of this batch that still have no row from it.
  SELECT coalesce(jsonb_agg(i ->> 'id' ORDER BY o), '[]'::jsonb), count(*)
    INTO v_missing, n_missing
    FROM jsonb_array_elements(b.items) WITH ORDINALITY AS x(i, o)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.advert_labels l
      WHERE l.message_id = i ->> 'id'
        AND l.prompt_version = b.prompt_version
        AND l.batch_id = b.batch_id);
  n_done := jsonb_array_length(b.items) - n_missing;

  UPDATE public.advert_label_batches
     SET status = CASE WHEN n_missing = 0 THEN 'done' ELSE 'partial' END,
         completed_at = now(),
         accepted = n_done,
         missing = v_missing,
         rejected = v_rejected
   WHERE batch_id = b.batch_id;

  RETURN jsonb_build_object(
    'batch_id', b.batch_id,
    'accepted', n_done,
    'missing', v_missing,
    'rejected', v_rejected);
END;
$fn$;
`;

// Execute rights: anon only (plus USAGE on the schema, which reaching the
// function needs). Supabase's default privileges also hand new functions and
// tables to anon/authenticated/service_role, so take those back. Guarded on the
// roles existing, so a plain Postgres (tests, a Neon rollback) migrates too.
const GRANTS_SQL = `
  REVOKE ALL ON SCHEMA labeller_api FROM PUBLIC;
  REVOKE ALL ON FUNCTION labeller_api.submit_advert_labels(jsonb) FROM PUBLIC;
  DO $$
  DECLARE
    role_name text;
  BEGIN
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
      IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
        EXECUTE format('REVOKE ALL ON public.advert_label_batches, public.advert_labels, public.advert_labeller_secret, public.advert_fandom_reports FROM %I', role_name);
        EXECUTE format('REVOKE ALL ON FUNCTION labeller_api.submit_advert_labels(jsonb) FROM %I', role_name);
      END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
      GRANT USAGE ON SCHEMA labeller_api TO anon;
      GRANT EXECUTE ON FUNCTION labeller_api.submit_advert_labels(jsonb) TO anon;
    END IF;
  END $$;
`;

// Idempotent: safe on every boot. `run` is pool.query or a pg/PGlite client's.
async function initAdvertLabels(run) {
  await run(TABLES_SQL);
  await run(API_SCHEMA_SQL);
  await run(FUNCTION_SQL);
  await run(GRANTS_SQL);
}

module.exports = { CATEGORIES, initAdvertLabels, TABLES_SQL, API_SCHEMA_SQL, FUNCTION_SQL, GRANTS_SQL };
