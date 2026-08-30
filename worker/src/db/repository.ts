import postgres from "postgres";
import {
  SummaryTemplateSchema,
  TranscriptSchema,
  type Job,
  type Summary,
  type SummaryTemplate,
  type Transcript,
} from "@quorum/shared";
import { JobError, MeetingGoneError } from "../errors.js";
import { MIGRATIONS } from "./schema.js";

/** Arbitrary but fixed key; only this migration ever takes it. */
const MIGRATION_LOCK_KEY = 6_120_931_042;

export interface JobScope {
  tenantId: string;
  userId: string;
  sessionId: string;
}

export interface SaveTranscriptResult {
  transcriptId: string;
  /** `false` when this job had already produced a transcript — a replay. */
  created: boolean;
}

export interface SaveSummaryResult {
  summaryId: string;
  /** `false` when this job had already produced a summary — a replay. */
  created: boolean;
}

/** Persistence port; the in-memory implementation in the tests mirrors it. */
export interface TranscriptRepository {
  migrate(): Promise<void>;
  /**
   * Persists the transcript, or raises `MeetingGoneError` when the meeting was
   * deleted in the meantime. The check and the insert share one transaction.
   */
  saveTranscript(
    transcript: Transcript,
    scope: JobScope,
    jobId: string,
  ): Promise<SaveTranscriptResult>;
  saveJob(job: Job, scope: JobScope, attempt: number): Promise<void>;
  /**
   * The template this user has chosen for new recordings, or `null` when they
   * have chosen none — or when the one they chose no longer exists. The caller
   * falls back to the system template in both cases, so a deleted default never
   * leaves a meeting without a summary.
   */
  findDefaultTemplateId(tenantId: string, userId: string): Promise<string | null>;
  close(): Promise<void>;
}

/** The summary half of the same store, kept as its own port for testability. */
export interface SummaryRepository {
  /** Writes a template if that (id, version) is not stored yet. */
  seedTemplate(template: SummaryTemplate): Promise<void>;
  /** Highest version of a template visible to the tenant, or `null`. */
  loadTemplate(templateId: string, tenantId: string): Promise<SummaryTemplate | null>;
  loadTranscript(transcriptId: string, tenantId: string): Promise<Transcript | null>;
  /**
   * Whether the meeting still exists in the caller's tenant. Used to tell a
   * deleted meeting apart from a genuinely broken job when the transcript a
   * summarize job names cannot be loaded.
   */
  meetingExists(meetingId: string, tenantId: string): Promise<boolean>;
  /**
   * Persists the summary, or raises `MeetingGoneError` when the meeting was
   * deleted in the meantime. The check and the insert share one transaction.
   */
  saveSummary(summary: Summary, scope: JobScope, jobId: string): Promise<SaveSummaryResult>;
  saveJob(job: Job, scope: JobScope, attempt: number): Promise<void>;
}

export class PostgresRepository implements TranscriptRepository, SummaryRepository {
  private readonly sql: postgres.Sql;

  constructor(connectionString: string, options: postgres.Options<Record<string, never>> = {}) {
    this.sql = postgres(connectionString, { max: 4, ...options });
  }

  /**
   * Applies the schema under an advisory lock. `CREATE ... IF NOT EXISTS` is
   * idempotent but not concurrency-safe: two worker replicas starting at the
   * same moment can both pass the existence check and then collide in the
   * catalog. The lock is released when the transaction ends.
   */
  async migrate(): Promise<void> {
    await this.sql.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
      for (const statement of MIGRATIONS) {
        await sql.unsafe(statement);
      }
    });
  }

  /**
   * Idempotent write: `job_id` is unique, so a retried or replayed job either
   * inserts its (deterministically identified) transcript once or finds the row
   * it wrote before. A crash between the insert and the queue acknowledgement
   * therefore costs a repeated transcription, never a duplicate transcript.
   *
   * Activating the new transcript and deactivating the previous one happen in
   * the same transaction as the insert, so the partial unique index on
   * `is_active` can never see two active rows for a meeting.
   */
  async saveTranscript(
    transcript: Transcript,
    scope: JobScope,
    jobId: string,
  ): Promise<SaveTranscriptResult> {
    try {
      return await this.sql.begin(async (sql) => {
        await requireMeeting(sql, transcript.meetingId, scope.tenantId);

        const existing = await sql<{ id: string }[]>`
          SELECT id FROM transcripts WHERE job_id = ${jobId} FOR UPDATE
        `;
        const previous = existing[0];
        if (previous) return { transcriptId: previous.id, created: false };

        await sql`
          UPDATE transcripts SET is_active = false
          WHERE meeting_id = ${transcript.meetingId} AND is_active
        `;
        const inserted = await sql<{ id: string }[]>`
          INSERT INTO transcripts (
            id, job_id, meeting_id, tenant_id, user_id, session_id, schema_version,
            model, model_version, language, is_active, recorded_at, created_at, transcript
          ) VALUES (
            ${transcript.id}, ${jobId}, ${transcript.meetingId}, ${scope.tenantId},
            ${scope.userId}, ${scope.sessionId}, ${transcript.schemaVersion},
            ${transcript.model}, ${transcript.modelVersion}, ${transcript.language},
            ${transcript.isActive}, ${transcript.recordedAt}, ${transcript.createdAt},
            ${sql.json(transcript as unknown as postgres.JSONValue)}
          )
          ON CONFLICT (job_id) DO NOTHING
          RETURNING id
        `;
        const row = inserted[0];
        // Lost the race against a concurrent attempt of the same job: its row
        // is authoritative and identical, so adopt it.
        if (!row) {
          const winner = await sql<{ id: string }[]>`
            SELECT id FROM transcripts WHERE job_id = ${jobId}
          `;
          const found = winner[0];
          if (!found) throw new Error("transcript vanished after a conflicting insert");
          return { transcriptId: found.id, created: false };
        }
        return { transcriptId: row.id, created: true };
      });
    } catch (error) {
      if (error instanceof JobError || error instanceof MeetingGoneError) throw error;
      throw new JobError("TRANSCRIPT_PERSIST_FAILED", "failed to persist the transcript", {
        retryable: true,
        cause: error,
      });
    }
  }

  /**
   * Records the job state of `shared/src/job.ts` — queued, running, succeeded,
   * failed.
   *
   * The write is skipped, silently, when the meeting no longer exists. A job
   * row is as much a piece of the meeting as its transcript is — the deletion
   * cascade removes both in one transaction — so inserting one afterwards would
   * leave residue behind a meeting the user deleted. The handlers already
   * abandon such a job, but the guard belongs here as well: the very first
   * thing a job does is record itself as `running`, long before it reaches a
   * point where a handler could check anything.
   */
  async saveJob(job: Job, scope: JobScope, attempt: number): Promise<void> {
    try {
      await this.sql.begin(async (sql) => {
        await requireMeeting(sql, job.meetingId, scope.tenantId);
        await sql`
          INSERT INTO jobs (
            id, meeting_id, tenant_id, user_id, session_id, type, status, progress,
            error, result_id, attempt, created_at, started_at, finished_at, updated_at
          ) VALUES (
            ${job.id}, ${job.meetingId}, ${scope.tenantId}, ${scope.userId}, ${scope.sessionId},
            ${job.type}, ${job.status}, ${job.progress}, ${job.error ? sql.json(job.error) : null},
            ${job.resultId}, ${attempt}, ${job.createdAt}, ${job.startedAt}, ${job.finishedAt}, now()
          )
          ON CONFLICT (id) DO UPDATE SET
            status = EXCLUDED.status,
            progress = EXCLUDED.progress,
            error = EXCLUDED.error,
            result_id = EXCLUDED.result_id,
            attempt = EXCLUDED.attempt,
            started_at = COALESCE(jobs.started_at, EXCLUDED.started_at),
            finished_at = EXCLUDED.finished_at,
            updated_at = now()
        `;
      });
    } catch (error) {
      // A deleted meeting is not a persistence failure — there was simply
      // nothing left to record against.
      if (error instanceof MeetingGoneError) return;
      throw new JobError("TRANSCRIPT_PERSIST_FAILED", "failed to record the job state", {
        retryable: true,
        cause: error,
      });
    }
  }

  /**
   * Reads the user's chosen default template.
   *
   * The join is what makes "deleting the default falls back to the system
   * template" true without a cleanup pass: a pointer whose template is gone
   * matches no row and reads as no default. The predicate carries tenant and
   * user (ADR-001), so a stored pointer is only ever resolved for the person it
   * belongs to.
   */
  async findDefaultTemplateId(tenantId: string, userId: string): Promise<string | null> {
    try {
      const rows = await this.sql<{ default_template_id: string }[]>`
        SELECT s.default_template_id
          FROM user_settings s
         WHERE s.tenant_id = ${tenantId}
           AND s.user_id = ${userId}
           AND EXISTS (
             SELECT 1 FROM summary_templates t
              WHERE t.id = s.default_template_id
                AND (t.scope = 'system'
                     OR (t.tenant_id = ${tenantId} AND t.user_id = ${userId}))
           )
         LIMIT 1
      `;
      return rows[0]?.default_template_id ?? null;
    } catch (error) {
      throw new JobError("SUMMARY_PERSIST_FAILED", "failed to read the default summary template", {
        retryable: true,
        cause: error,
      });
    }
  }

  /**
   * Inserts a template version if it is not stored yet.
   *
   * `DO NOTHING` rather than `DO UPDATE` is the whole contract of ADR-004 §2:
   * a stored template version is immutable, because summaries snapshotted from
   * it must stay explicable. Changing the system template means bumping its
   * `version` in code, which inserts a new row and leaves the old one readable.
   */
  async seedTemplate(template: SummaryTemplate): Promise<void> {
    try {
      await this.sql`
        INSERT INTO summary_templates (
          id, version, schema_version, name, scope, tenant_id, user_id, based_on, template
        ) VALUES (
          ${template.id}, ${template.version}, ${template.schemaVersion}, ${template.name},
          ${template.scope}, ${null}, ${null}, ${template.basedOn},
          ${this.sql.json(template as unknown as postgres.JSONValue)}
        )
        ON CONFLICT (id, version) DO NOTHING
      `;
    } catch (error) {
      throw new JobError("SUMMARY_PERSIST_FAILED", "failed to seed the summary template", {
        retryable: true,
        cause: error,
      });
    }
  }

  /**
   * Loads the highest stored version of a template.
   *
   * Visibility follows ADR-001: a system template belongs to everybody, a user
   * template only to the tenant that owns it. The tenant filter lives in the
   * query rather than in a caller's check so that a summarize payload naming
   * another tenant's template id finds nothing instead of leaking it.
   */
  async loadTemplate(templateId: string, tenantId: string): Promise<SummaryTemplate | null> {
    try {
      const rows = await this.sql<{ template: unknown }[]>`
        SELECT template FROM summary_templates
        WHERE id = ${templateId}
          AND (scope = 'system' OR tenant_id = ${tenantId})
        ORDER BY version DESC
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) return null;
      const parsed = SummaryTemplateSchema.safeParse(row.template);
      if (!parsed.success) {
        throw new JobError(
          "SUMMARY_TEMPLATE_NOT_FOUND",
          `stored template ${templateId} does not match the template schema: ${parsed.error.message}`,
          { retryable: false },
        );
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof JobError) throw error;
      throw new JobError("SUMMARY_PERSIST_FAILED", "failed to read the summary template", {
        retryable: true,
        cause: error,
      });
    }
  }

  async loadTranscript(transcriptId: string, tenantId: string): Promise<Transcript | null> {
    try {
      const rows = await this.sql<{ transcript: unknown }[]>`
        SELECT transcript FROM transcripts
        WHERE id = ${transcriptId} AND tenant_id = ${tenantId}
      `;
      const row = rows[0];
      if (!row) return null;
      const parsed = TranscriptSchema.safeParse(row.transcript);
      if (!parsed.success) {
        throw new JobError(
          "TRANSCRIPT_NOT_FOUND",
          `stored transcript ${transcriptId} does not match the transcript schema: ${parsed.error.message}`,
          { retryable: false },
        );
      }
      return parsed.data;
    } catch (error) {
      if (error instanceof JobError) throw error;
      throw new JobError("SUMMARY_PERSIST_FAILED", "failed to read the transcript", {
        retryable: true,
        cause: error,
      });
    }
  }

  /**
   * Idempotent write, mirroring `saveTranscript`: `job_id` is unique, so a
   * retried or replayed summarize job either inserts its deterministically
   * identified summary once or finds the row it wrote before. That matters more
   * here than for transcription — a duplicate insert would mean a second paid
   * LLM call's worth of output, and the call has already been made by the time
   * we get here.
   *
   * Superseding the previous summary and inserting the new one share one
   * transaction, so the partial unique index on `(meeting_id, template_id)`
   * never sees two active rows for the same template.
   */
  async saveSummary(summary: Summary, scope: JobScope, jobId: string): Promise<SaveSummaryResult> {
    try {
      return await this.sql.begin(async (sql) => {
        await requireMeeting(sql, summary.meetingId, scope.tenantId);

        const existing = await sql<{ id: string }[]>`
          SELECT id FROM summaries WHERE job_id = ${jobId} FOR UPDATE
        `;
        const previous = existing[0];
        if (previous) return { summaryId: previous.id, created: false };

        await sql`
          UPDATE summaries SET is_active = false
          WHERE meeting_id = ${summary.meetingId}
            AND template_id = ${summary.templateSnapshot.templateId}
            AND is_active
        `;
        const inserted = await sql<{ id: string }[]>`
          INSERT INTO summaries (
            id, job_id, meeting_id, transcript_id, tenant_id, user_id, session_id,
            schema_version, template_id, template_version, model, prompt_version,
            is_active, created_at, summary
          ) VALUES (
            ${summary.id}, ${jobId}, ${summary.meetingId}, ${summary.transcriptId},
            ${scope.tenantId}, ${scope.userId}, ${scope.sessionId}, ${summary.schemaVersion},
            ${summary.templateSnapshot.templateId}, ${summary.templateSnapshot.templateVersion},
            ${summary.model}, ${summary.promptVersion}, ${summary.isActive}, ${summary.createdAt},
            ${sql.json(summary as unknown as postgres.JSONValue)}
          )
          ON CONFLICT (job_id) DO NOTHING
          RETURNING id
        `;
        const row = inserted[0];
        // Lost the race against a concurrent attempt of the same job: its row is
        // authoritative and identical, so adopt it.
        if (!row) {
          const winner = await sql<{ id: string }[]>`
            SELECT id FROM summaries WHERE job_id = ${jobId}
          `;
          const found = winner[0];
          if (!found) throw new Error("summary vanished after a conflicting insert");
          return { summaryId: found.id, created: false };
        }
        return { summaryId: row.id, created: true };
      });
    } catch (error) {
      if (error instanceof JobError || error instanceof MeetingGoneError) throw error;
      throw new JobError("SUMMARY_PERSIST_FAILED", "failed to persist the summary", {
        retryable: true,
        cause: error,
      });
    }
  }

  async meetingExists(meetingId: string, tenantId: string): Promise<boolean> {
    try {
      return await this.sql.begin(async (sql) => {
        await requireMeeting(sql, meetingId, tenantId);
        return true;
      });
    } catch (error) {
      if (error instanceof MeetingGoneError) return false;
      throw new JobError("SUMMARY_PERSIST_FAILED", "failed to check the meeting", {
        retryable: true,
        cause: error,
      });
    }
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

/**
 * Raises `MeetingGoneError` unless the meeting still exists for this tenant.
 *
 * WHY THE WORKER READS A SERVER-OWNED TABLE: `meetings` is the authority on
 * whether a recording exists — the deletion cascade removes that row in the
 * same transaction as the artifacts — so it is the only honest thing to check.
 * This mirrors the existing arrangement in the other direction, where the API
 * server reads the worker's `transcripts`, `summaries` and `jobs` tables
 * without writing them. Folding both schemas into a single migration owner is
 * the follow-up already noted in `schema.ts` on both sides; this call does not
 * change that plan.
 *
 * WHY `FOR SHARE`: the row lock is what makes the check race-free rather than
 * merely narrow. The delete cascade opens with `SELECT ... FOR UPDATE` on the
 * same row, so a delete that arrives after this statement blocks until the
 * insert has committed, and a delete that arrives before it makes this
 * statement wait and then find nothing. Both transactions take the `meetings`
 * row first, so the lock order is consistent and cannot deadlock.
 *
 * WHY A MISSING TABLE COUNTS AS PRESENT: the server may not have applied its
 * schema yet on a fresh database. No meeting can have been deleted if no
 * meeting was ever recorded, so failing open here discards no data — whereas
 * failing closed would throw away real work over a start-order race.
 */
async function requireMeeting(
  sql: postgres.TransactionSql,
  meetingId: string,
  tenantId: string,
): Promise<void> {
  const registered = await sql<{ present: boolean }[]>`
    SELECT to_regclass('public.meetings') IS NOT NULL AS present
  `;
  if (registered[0]?.present !== true) return;

  const rows = await sql<{ id: string }[]>`
    SELECT id FROM meetings
     WHERE id = ${meetingId} AND tenant_id = ${tenantId}
     FOR SHARE
  `;
  if (rows.length === 0) throw new MeetingGoneError(meetingId);
}
