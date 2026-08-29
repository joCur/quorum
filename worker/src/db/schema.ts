/**
 * Minimal domain schema owned by the worker.
 *
 * WHY PLAIN SQL: pg-boss already owns a PostgreSQL connection and runs its own
 * migrations on start (ADR-006 §3), so the worker adds a second small
 * connection and two idempotent `CREATE TABLE IF NOT EXISTS` statements rather
 * than an ORM plus a migration runner. Two tables do not justify that
 * machinery, and the statements below are the whole story. When the REST API
 * grows real query needs, moving to a proper migration tool is a contained
 * change — this file is the starting point, not a permanent home.
 *
 * WHY JSONB: transcripts are versioned, schema-validated documents that we read
 * whole and rarely query field by field (ADR-006 §4). The queryable metadata
 * lives in real columns next to the blob, which is what keeps the deletion
 * cascade of ADR-001 auditable.
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
];
