/**
 * Schema owned by the API server.
 *
 * SPLIT OWNERSHIP, ON PURPOSE FOR NOW: the worker owns `transcripts`, `summaries`,
 * `summary_templates` and `jobs`; the server owns `meetings` and `transcript_corrections`. Both
 * packages apply their statements idempotently under their own advisory lock, so start order
 * does not matter. The server reads the worker's tables through plain SQL and never writes
 * them. Consolidating all of it into one migration owner is a follow-up — see the note in
 * `worker/src/db/schema.ts`, which says the same thing from the other side.
 *
 * ONE EXCEPTION TO "THE SERVER IS THE ONLY WRITER": the summary worker writes `meetings.title`,
 * and only where it is empty, to give a recording nobody named the name its summary suggested
 * (ADR-009). Every other column, and every insert and delete, is the server's alone.
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

  /*
   * WHAT A MEETING COST, ON THE MEETING.
   *
   * The storage and recording-time quotas need to know what a user has already consumed. These
   * two columns carry that per meeting rather than as counters in a table of their own, and that
   * is a deliberate choice:
   *
   * - A counter has to be decremented when a meeting is deleted. These columns are deleted *with*
   *   the meeting by the ADR-001 cascade that already exists, so giving the storage back is not a
   *   second thing that can fail.
   * - A counter drifts the first time a decrement is lost, and drift in a quota stays invisible
   *   until somebody is wrongly locked out. A sum over facts cannot drift.
   * - Both values are recomputable from object storage, so a wrong number is repairable rather
   *   than permanent.
   *
   * `audio_bytes` is what the session's objects occupy; `recorded_seconds` is audio time, so
   * pauses do not count. The transcript-derived duration the meeting list shows is a different
   * number with a different job: it exists only after transcription, and a quota cannot wait for
   * the pipeline it is meant to protect.
   */
  `ALTER TABLE meetings ADD COLUMN IF NOT EXISTS audio_bytes bigint NOT NULL DEFAULT 0`,
  `ALTER TABLE meetings
     ADD COLUMN IF NOT EXISTS recorded_seconds double precision NOT NULL DEFAULT 0`,

  /*
   * WHAT THE USER SAYS A SEGMENT SHOULD READ (ADR-003 §2, ADR-011).
   *
   * A correction is an overlay, and it lives here rather than inside the transcript document: that
   * document belongs to the transcription worker, and the immutability of machine output is worth
   * more as "nobody else holds a pen" than as an agreement about which keys are safe to touch.
   *
   * A row exists only where a correction exists. Resetting a segment deletes its row, which is
   * what makes the original recoverable by construction — there is no second copy to keep in step.
   *
   * The key is the transcript, not the meeting: a meeting can have several transcripts (ADR-003
   * §3), and a correction was made against the wording of one of them. Reprocessing therefore
   * starts uncorrected instead of pasting old edits onto text that may no longer say the same
   * thing.
   */
  `CREATE TABLE IF NOT EXISTS transcript_corrections (
     tenant_id         text NOT NULL,
     user_id           text NOT NULL,
     meeting_id        uuid NOT NULL,
     transcript_id     uuid NOT NULL,
     segment_id        uuid NOT NULL,
     edited_text       text,
     edited_speaker_id uuid,
     created_at        timestamptz NOT NULL DEFAULT now(),
     updated_at        timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (tenant_id, transcript_id, segment_id)
   )`,

  // Reading a meeting loads every correction of its active transcript, and the deletion cascade
  // removes them by meeting. Both are this index (ADR-001 — the tenant leads every predicate).
  `CREATE INDEX IF NOT EXISTS transcript_corrections_meeting_idx
     ON transcript_corrections (tenant_id, meeting_id)`,
];
