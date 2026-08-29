import postgres from "postgres";
import type { Job, Transcript } from "@quorum/shared";
import { JobError } from "../errors.js";
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

/** Persistence port; the in-memory implementation in the tests mirrors it. */
export interface TranscriptRepository {
  migrate(): Promise<void>;
  saveTranscript(
    transcript: Transcript,
    scope: JobScope,
    jobId: string,
  ): Promise<SaveTranscriptResult>;
  saveJob(job: Job, scope: JobScope, attempt: number): Promise<void>;
  close(): Promise<void>;
}

export class PostgresTranscriptRepository implements TranscriptRepository {
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
      if (error instanceof JobError) throw error;
      throw new JobError("TRANSCRIPT_PERSIST_FAILED", "failed to persist the transcript", {
        retryable: true,
        cause: error,
      });
    }
  }

  /** Records the job state of `shared/src/job.ts` — queued, running, succeeded, failed. */
  async saveJob(job: Job, scope: JobScope, attempt: number): Promise<void> {
    try {
      await this.sql`
        INSERT INTO jobs (
          id, meeting_id, tenant_id, user_id, session_id, type, status, progress,
          error, result_id, attempt, created_at, started_at, finished_at, updated_at
        ) VALUES (
          ${job.id}, ${job.meetingId}, ${scope.tenantId}, ${scope.userId}, ${scope.sessionId},
          ${job.type}, ${job.status}, ${job.progress}, ${job.error ? this.sql.json(job.error) : null},
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
    } catch (error) {
      throw new JobError("TRANSCRIPT_PERSIST_FAILED", "failed to record the job state", {
        retryable: true,
        cause: error,
      });
    }
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
