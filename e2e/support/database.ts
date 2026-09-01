import postgres from "postgres";
import { stackEnv } from "./env.js";

/**
 * Read-only access to the tables the worker owns, so a test can assert that a job reached the
 * queue and that a transcript exists — the far end of the core path.
 */

// One pool for the whole worker process. `idle_timeout` matters: without it the open connection
// keeps the Playwright worker alive after the last spec, and closing it in an `afterAll` would
// break the next spec file, which shares this module.
const sql = postgres(stackEnv.databaseUrl, {
  max: 2,
  idle_timeout: 2,
  onnotice: () => undefined,
});

export interface QueuedTranscribeJob {
  id: string;
  state: string;
  sessionId: string;
  tenantId: string;
}

/**
 * Looks the enqueued transcribe job up by the session it belongs to. pg-boss keeps its jobs in
 * the `pgboss` schema; the payload is what the recording endpoint wrote.
 */
export async function findTranscribeJob(sessionId: string): Promise<QueuedTranscribeJob | null> {
  const rows = await sql<{ id: string; state: string; data: Record<string, unknown> }[]>`
    SELECT id, state, data
    FROM pgboss.job
    WHERE name = 'transcribe' AND data->>'sessionId' = ${sessionId}
    ORDER BY created_on DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    state: row.state,
    sessionId: String(row.data["sessionId"]),
    tenantId: String(row.data["tenantId"]),
  };
}

export interface FailedJobRow {
  id: string;
  type: string;
  code: string;
  message: string;
}

/**
 * The job row a failed stage left behind, with the code and the developer-facing message.
 *
 * A UI assertion about a failure needs the failure to have happened first, and this is the row the
 * API derives the meeting's failed state from — so waiting for it separates "the pipeline never
 * failed" from "the screen renders it wrong".
 */
export async function findFailedJob(
  sessionId: string,
  type: "transcribe" | "summarize",
): Promise<FailedJobRow | null> {
  if (!(await tableExists("jobs"))) return null;

  const rows = await sql<{ id: string; type: string; error: { code: string; message: string } }[]>`
    SELECT id, type, error
    FROM jobs
    WHERE session_id = ${sessionId}::uuid AND type = ${type} AND status = 'failed'
    ORDER BY updated_at DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    type: row.type,
    code: row.error?.code ?? "",
    message: row.error?.message ?? "",
  };
}

export interface SummaryRow {
  id: string;
  meetingId: string;
  transcriptId: string;
  tenantId: string;
  userId: string;
  templateId: string;
  model: string;
  isActive: boolean;
}

/** The far end of the core path: the summary derived from a transcript (ADR-004). */
export async function findSummary(sessionId: string): Promise<SummaryRow | null> {
  if (!(await tableExists("summaries"))) return null;

  const rows = await sql<
    {
      id: string;
      meeting_id: string;
      transcript_id: string;
      tenant_id: string;
      user_id: string;
      template_id: string;
      model: string;
      is_active: boolean;
    }[]
  >`
    SELECT id, meeting_id, transcript_id, tenant_id, user_id, template_id, model, is_active
    FROM summaries
    WHERE session_id = ${sessionId}::uuid
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    meetingId: row.meeting_id,
    transcriptId: row.transcript_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    templateId: row.template_id,
    model: row.model,
    isActive: row.is_active,
  };
}

/**
 * Every summary of a session, newest first.
 *
 * A meeting may have several (ADR-004 section 3: one active per template), which is exactly what
 * regenerating with a different template produces — so a spec that checks regeneration has to see
 * all of them, not just the latest.
 */
export async function findSummaries(sessionId: string): Promise<SummaryRow[]> {
  if (!(await tableExists("summaries"))) return [];

  const rows = await sql<
    {
      id: string;
      meeting_id: string;
      transcript_id: string;
      tenant_id: string;
      user_id: string;
      template_id: string;
      model: string;
      is_active: boolean;
    }[]
  >`
    SELECT id, meeting_id, transcript_id, tenant_id, user_id, template_id, model, is_active
    FROM summaries
    WHERE session_id = ${sessionId}::uuid
    ORDER BY created_at DESC
  `;
  return rows.map((row) => ({
    id: row.id,
    meetingId: row.meeting_id,
    transcriptId: row.transcript_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    templateId: row.template_id,
    model: row.model,
    isActive: row.is_active,
  }));
}

/**
 * The id of a user template by the name it was saved under.
 *
 * Asserting which template a summary was made with means naming that template, and the UI only
 * ever shows its name — the id lives in the store. Reading it here keeps the assertion about the
 * row that was actually written rather than about "not the system one".
 */
export async function findUserTemplateId(name: string): Promise<string | null> {
  if (!(await tableExists("summary_templates"))) return null;

  const rows = await sql<{ id: string }[]>`
    SELECT id FROM summary_templates
     WHERE name = ${name} AND scope = 'user'
     ORDER BY version DESC
     LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

/**
 * Queue rows pg-boss still holds for a meeting, live and archived.
 *
 * These are queue internals, and the deletion cascade reaches into them on purpose: a `transcribe`
 * job left behind would be picked up after the delete and write a fresh transcript for a meeting
 * that no longer exists. That is the one thing the deletion promise cannot survive, so the suite
 * checks it rather than trusting the comment.
 */
export async function countQueueRows(meetingId: string): Promise<number> {
  let total = 0;
  for (const table of ["job", "archive"] as const) {
    const [present] = await sql<{ exists: boolean }[]>`
      SELECT to_regclass(${`pgboss.${table}`}) IS NOT NULL AS exists
    `;
    if (present?.exists !== true) continue;
    const rows = await sql<{ count: string }[]>`
      SELECT count(*) AS count
      FROM ${sql("pgboss")}.${sql(table)}
      WHERE data->'job'->>'meetingId' = ${meetingId}
    `;
    total += Number.parseInt(rows[0]?.count ?? "0", 10);
  }
  return total;
}

/**
 * How many rows a table still holds for a session — the shape a deletion assertion needs.
 */
export async function countRowsForSession(
  table: "transcripts" | "summaries" | "jobs",
  sessionId: string,
): Promise<number> {
  if (!(await tableExists(table))) return 0;
  // The table name is not user input: the union type above is the whole allowed set.
  const rows = await sql<{ count: string }[]>`
    SELECT count(*) AS count FROM ${sql(table)} WHERE session_id = ${sessionId}::uuid
  `;
  return Number.parseInt(rows[0]?.count ?? "0", 10);
}

/**
 * The worker creates its tables on start. Querying one before that would fail rather than return
 * nothing, which is a different — and misleading — failure for a polling assertion.
 */
async function tableExists(name: string): Promise<boolean> {
  const [present] = await sql<{ exists: boolean }[]>`
    SELECT to_regclass(${`public.${name}`}) IS NOT NULL AS exists
  `;
  return present?.exists === true;
}

export interface TranscriptRow {
  id: string;
  meetingId: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  language: string;
  model: string;
  isActive: boolean;
}

export async function findTranscript(sessionId: string): Promise<TranscriptRow | null> {
  if (!(await tableExists("transcripts"))) return null;

  const rows = await sql<
    {
      id: string;
      meeting_id: string;
      tenant_id: string;
      user_id: string;
      session_id: string;
      language: string;
      model: string;
      is_active: boolean;
    }[]
  >`
    SELECT id, meeting_id, tenant_id, user_id, session_id, language, model, is_active
    FROM transcripts
    WHERE session_id = ${sessionId}::uuid
    ORDER BY created_at DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  return {
    id: row.id,
    meetingId: row.meeting_id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    sessionId: row.session_id,
    language: row.language,
    model: row.model,
    isActive: row.is_active,
  };
}
