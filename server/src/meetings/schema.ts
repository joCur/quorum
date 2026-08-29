/**
 * Schema owned by the API server.
 *
 * SPLIT OWNERSHIP, ON PURPOSE FOR NOW: the worker owns `transcripts`, `summaries`,
 * `summary_templates` and `jobs`; the server owns `meetings`, the only table it writes. Both
 * packages apply their statements idempotently under their own advisory lock, so start order
 * does not matter. The server reads the worker's tables through plain SQL and never writes
 * them. Consolidating all of it into one migration owner is a follow-up — see the note in
 * `worker/src/db/schema.ts`, which says the same thing from the other side.
 *
 * WHY A MEETINGS TABLE AT ALL: before this table, a meeting existed only as a `session.json`
 * object in storage plus whatever rows the pipeline had produced. Listing meetings would have
 * meant a prefix listing plus one object read per meeting, and searching would have meant
 * reading all of them. The table is the queryable index over recordings; object storage stays
 * the source of truth for the audio itself.
 */
export const MEETING_MIGRATIONS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS meetings (
     id            uuid PRIMARY KEY,
     tenant_id     text NOT NULL,
     user_id       text NOT NULL,
     session_id    uuid NOT NULL UNIQUE,
     title         text,
     audio_format  jsonb NOT NULL,
     created_at    timestamptz NOT NULL,
     finalized_at  timestamptz,
     updated_at    timestamptz NOT NULL DEFAULT now()
   )`,

  // The list query: newest first within one tenant and user (ADR-001 — every query filters by
  // at least the tenant).
  `CREATE INDEX IF NOT EXISTS meetings_scope_created_idx
     ON meetings (tenant_id, user_id, created_at DESC)`,
];
