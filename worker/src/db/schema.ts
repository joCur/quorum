/**
 * Minimal domain schema owned by the worker.
 *
 * WHY PLAIN SQL: pg-boss already owns a PostgreSQL connection and runs its own
 * migrations on start (ADR-006 §3), so the worker adds a second small
 * connection and a handful of idempotent `CREATE TABLE IF NOT EXISTS`
 * statements rather than an ORM plus a migration runner. A schema this size
 * does not justify that machinery, and the statements below are the whole
 * story. When the REST API grows real query needs, moving to a proper migration
 * tool is a contained change — this file is the starting point, not a permanent
 * home.
 *
 * WHY JSONB: transcripts, summaries and templates are versioned,
 * schema-validated documents that we read whole and rarely query field by field
 * (ADR-006 §4). The queryable metadata lives in real columns next to the blob,
 * which is what keeps the deletion cascade of ADR-001 auditable.
 *
 * WHAT THIS WORKER TOUCHES OUTSIDE ITS OWN TABLES: the server-owned `meetings`
 * table is read to tell a deleted meeting from a broken job, and one column of
 * it is written — `title`, and only where it is empty, to give a recording
 * nobody named the name its summary suggested (ADR-009). Nothing else there is
 * the worker's to change.
 */
export const MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS transcripts (
     id               uuid PRIMARY KEY,
     job_id           uuid NOT NULL UNIQUE,
     meeting_id       uuid NOT NULL,
     tenant_id        text NOT NULL,
     user_id          text NOT NULL,
     session_id       uuid NOT NULL,
     schema_version   integer NOT NULL,
     model            text NOT NULL,
     model_version    text NOT NULL,
     language         text NOT NULL,
     is_active        boolean NOT NULL DEFAULT true,
     recorded_at      timestamptz NOT NULL,
     created_at       timestamptz NOT NULL,
     transcript       jsonb NOT NULL
   )`,

  // Exactly one active transcript per meeting (ADR-003 §3) — enforced by the
  // database, not by application discipline.
  `CREATE UNIQUE INDEX IF NOT EXISTS transcripts_one_active_per_meeting
     ON transcripts (meeting_id) WHERE is_active`,

  `CREATE INDEX IF NOT EXISTS transcripts_tenant_meeting_idx
     ON transcripts (tenant_id, meeting_id)`,

  // Job state as defined by the shared job schema. The queue row in pg-boss is
  // an implementation detail with its own lifetime; this table is what the API
  // reports to clients and what survives queue retention.
  `CREATE TABLE IF NOT EXISTS jobs (
     id           uuid PRIMARY KEY,
     meeting_id   uuid NOT NULL,
     tenant_id    text NOT NULL,
     user_id      text NOT NULL,
     session_id   uuid NOT NULL,
     type         text NOT NULL,
     status       text NOT NULL,
     progress     double precision,
     error        jsonb,
     result_id    uuid,
     attempt      integer NOT NULL DEFAULT 0,
     created_at   timestamptz NOT NULL,
     started_at   timestamptz,
     finished_at  timestamptz,
     updated_at   timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE INDEX IF NOT EXISTS jobs_tenant_meeting_idx ON jobs (tenant_id, meeting_id)`,

  // Summary templates (ADR-004). The system default is seeded on worker start;
  // user templates land in the same table with scope 'user' and a `based_on`
  // pointing at the template they inherit from. The primary key is
  // (id, version) because a template change is a new version, never an in-place
  // edit — the snapshot in an existing summary has to stay resolvable.
  `CREATE TABLE IF NOT EXISTS summary_templates (
     id             uuid NOT NULL,
     version        integer NOT NULL,
     schema_version integer NOT NULL,
     name           text NOT NULL,
     scope          text NOT NULL,
     tenant_id      text,
     user_id        text,
     based_on       uuid,
     template       jsonb NOT NULL,
     created_at     timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (id, version)
   )`,

  // A system template belongs to no tenant; user templates are tenant scoped.
  `CREATE INDEX IF NOT EXISTS summary_templates_tenant_idx
     ON summary_templates (tenant_id, scope)`,

  // Per-user preferences, one row per (tenant, user) — for now only the default
  // summary template a new recording is summarized with.
  //
  // WHY NOT A FLAG ON `summary_templates`: that table is keyed by (id, version)
  // and every edit inserts a new row, so a flag would have to be carried forward
  // on each insert and guarded by a partial unique index to keep two templates
  // from both claiming the default. The choice is not a property of the template
  // either — it belongs to the user, and switching defaults twice must not
  // rewrite rows that are immutable on purpose (ADR-004 §2).
  //
  // A `default_template_id` with no template behind it is not an error state:
  // the template it names may have been deleted, and resolution treats that as
  // "no default", which falls back to the system template.
  `CREATE TABLE IF NOT EXISTS user_settings (
     tenant_id           text NOT NULL,
     user_id             text NOT NULL,
     default_template_id uuid,
     updated_at          timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (tenant_id, user_id)
   )`,

  // The language new recordings start out in. Plain text rather than a check
  // constraint or an enum type: which tags the pickers offer is a product
  // decision that moves faster than a migration, and a stored tag the current
  // build no longer offers is read back as "no choice" rather than being
  // handed to the transcription backend.
  //
  // Added as an ALTER because the table above already exists in deployments
  // that predate the setting, and `CREATE TABLE IF NOT EXISTS` does not
  // reconcile columns.
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS transcription_language text`,

  // Terms the user wants the transcription biased towards, alphabetically
  // sorted as they are stored. `text[]` rather than jsonb: this is a short list
  // of scalars with no shape of its own, not a versioned document, and it is
  // read whole by the settings API and by nothing else.
  //
  // Uncapped in the schema on purpose. What fits in the transcription prompt is
  // a property of the model's context window, not of the database, and the caps
  // that enforce it live in `shared/src/vocabulary.ts` where both the screen and
  // the API read them. A check constraint here would only turn a tightened cap
  // into a migration that fails on rows a previous version legitimately wrote.
  `ALTER TABLE user_settings ADD COLUMN IF NOT EXISTS vocabulary text[]`,

  `CREATE TABLE IF NOT EXISTS summaries (
     id               uuid PRIMARY KEY,
     job_id           uuid NOT NULL UNIQUE,
     meeting_id       uuid NOT NULL,
     transcript_id    uuid NOT NULL,
     tenant_id        text NOT NULL,
     user_id          text NOT NULL,
     session_id       uuid NOT NULL,
     schema_version   integer NOT NULL,
     template_id      uuid NOT NULL,
     template_version integer NOT NULL,
     model            text NOT NULL,
     prompt_version   text NOT NULL,
     is_active        boolean NOT NULL DEFAULT true,
     created_at       timestamptz NOT NULL,
     summary          jsonb NOT NULL
   )`,

  // ADR-004 §3: a meeting may have many summaries, but only one active per
  // template — regenerating with the same template supersedes, summarizing with
  // a different template adds. Enforced by the database, not by convention.
  `CREATE UNIQUE INDEX IF NOT EXISTS summaries_one_active_per_meeting_template
     ON summaries (meeting_id, template_id) WHERE is_active`,

  `CREATE INDEX IF NOT EXISTS summaries_tenant_meeting_idx
     ON summaries (tenant_id, meeting_id)`,

  `CREATE INDEX IF NOT EXISTS summaries_transcript_idx ON summaries (transcript_id)`,
];
