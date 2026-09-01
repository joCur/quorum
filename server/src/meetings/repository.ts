import postgres from "postgres";
import {
  JobSchema,
  SummarySchema,
  TranscriptSchema,
  type AudioFormat,
  type Job,
  type Meeting,
  type Summary,
  type Transcript,
} from "@quorum/shared";
import type { AccountUsage, RecordingUsage } from "../recording/types.js";
import { deriveMeetingState, type StageState } from "./status.js";
import { MEETING_MIGRATIONS } from "./schema.js";

/** Arbitrary but fixed key; only the server's meeting migration ever takes it. */
const MIGRATION_LOCK_KEY = 6_120_931_043;

/** PostgreSQL `undefined_table` — the worker has not applied its schema yet. */
const UNDEFINED_TABLE = "42P01";

/** Tenant and user a request runs under (ADR-001). Never read from the request body. */
export interface MeetingScope {
  readonly tenantId: string;
  readonly userId: string;
}

/** The row the recording endpoint writes when a session starts. */
export interface MeetingRecord {
  meetingId: string;
  sessionId: string;
  tenantId: string;
  userId: string;
  title: string | null;
  audioFormat: AudioFormat;
  createdAt: string;
}

export interface ListMeetingsOptions {
  /** Case-insensitive substring match on the meeting title. */
  search?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface MeetingDetailRow {
  meeting: Meeting;
  transcript: Transcript | null;
  summaries: Summary[];
  jobs: Job[];
}

/**
 * Persistence port for meetings. The routes depend only on this, so they can be exercised
 * without a database.
 */
export interface MeetingStore {
  migrate(): Promise<void>;
  /** Called when a recording session starts. Idempotent on the session id. */
  recordSession(record: MeetingRecord): Promise<void>;
  /** Called when a recording is finalized; makes the audio playable and starts the pipeline. */
  markFinalized(scope: MeetingScope, sessionId: string, finalizedAt: string): Promise<void>;
  /**
   * Stores what a session has consumed. Monotonic: a stored value is only ever raised, never
   * lowered, because a reconnecting connection starts counting from zero again.
   */
  recordUsage(scope: MeetingScope, sessionId: string, usage: RecordingUsage): Promise<void>;
  /** What the user has consumed: stored bytes overall, recorded seconds since `monthStart`. */
  readUsage(scope: MeetingScope, monthStart: string): Promise<AccountUsage>;
  listMeetings(scope: MeetingScope, options?: ListMeetingsOptions): Promise<Meeting[]>;
  /** `null` when the meeting does not exist *or* belongs to another tenant or user. */
  findMeeting(scope: MeetingScope, meetingId: string): Promise<MeetingDetailRow | null>;
  /**
   * Removes every database row belonging to a meeting — summaries, transcripts, job rows, any
   * queued work and the meeting itself — in one transaction (ADR-001). Returns `false` when
   * there was no such meeting in the caller's scope.
   */
  deleteMeeting(scope: MeetingScope, meetingId: string): Promise<boolean>;
  close(): Promise<void>;
}

export const DEFAULT_MEETING_LIMIT = 50;
export const MAX_MEETING_LIMIT = 200;

interface MeetingRow {
  id: string;
  session_id: string;
  title: string | null;
  audio_format: AudioFormat;
  created_at: Date;
  finalized_at: Date | null;
}

/** Pipeline facts gathered for a batch of meetings. */
interface PipelineFacts {
  transcripts: Map<string, { language: string; durationSeconds: number | null }>;
  summarized: Set<string>;
  /** Latest job row per meeting, keyed by job type. */
  jobTypes: Map<string, Map<string, StageState>>;
}

export class PostgresMeetingStore implements MeetingStore {
  private readonly sql: postgres.Sql;

  constructor(connectionString: string, options: postgres.Options<Record<string, never>> = {}) {
    this.sql = postgres(connectionString, { max: 4, ...options });
  }

  /**
   * Applies the meetings schema under an advisory lock. `CREATE ... IF NOT EXISTS` is idempotent
   * but not concurrency-safe: two replicas starting together can both pass the existence check
   * and then collide in the catalog.
   */
  async migrate(): Promise<void> {
    await this.sql.begin(async (sql) => {
      await sql`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`;
      for (const statement of MEETING_MIGRATIONS) {
        await sql.unsafe(statement);
      }
    });
  }

  async recordSession(record: MeetingRecord): Promise<void> {
    await this.sql`
      INSERT INTO meetings (
        id, tenant_id, user_id, session_id, title, audio_format, created_at
      ) VALUES (
        ${record.meetingId}, ${record.tenantId}, ${record.userId}, ${record.sessionId},
        ${record.title}, ${this.sql.json(record.audioFormat as unknown as postgres.JSONValue)},
        ${record.createdAt}
      )
      ON CONFLICT (session_id) DO UPDATE SET
        -- A repeat of this write carries the title the recording started with, which for an
        -- unnamed recording is null. Coalescing keeps it from erasing a name the row has been
        -- given since — today the one the summary suggested, later a rename.
        title = COALESCE(EXCLUDED.title, meetings.title),
        updated_at = now()
    `;
  }

  /**
   * The tenant and user are part of the predicate rather than of a prior lookup: a finalize for
   * a session outside the caller's scope then matches no row instead of touching one.
   */
  async markFinalized(scope: MeetingScope, sessionId: string, finalizedAt: string): Promise<void> {
    await this.sql`
      UPDATE meetings
         SET finalized_at = ${finalizedAt}, updated_at = now()
       WHERE session_id = ${sessionId}
         AND tenant_id = ${scope.tenantId}
         AND user_id = ${scope.userId}
         AND finalized_at IS NULL
    `;
  }

  /**
   * `GREATEST` rather than an assignment: a client that reconnects mid-recording starts its
   * byte counter from zero, and the row must not fall back to that. The effect is that usage of
   * one session only ever climbs, which is the direction a quota can safely be wrong in.
   */
  async recordUsage(scope: MeetingScope, sessionId: string, usage: RecordingUsage): Promise<void> {
    await this.sql`
      UPDATE meetings
         SET audio_bytes = GREATEST(audio_bytes, ${Math.round(usage.audioBytes)}),
             recorded_seconds = GREATEST(recorded_seconds, ${usage.recordedSeconds}),
             updated_at = now()
       WHERE session_id = ${sessionId}
         AND tenant_id = ${scope.tenantId}
         AND user_id = ${scope.userId}
    `;
  }

  /**
   * Usage is summed from the meetings themselves, so it is exactly as durable as the meetings
   * are: nothing to reconcile after a restart, and a deleted meeting stops counting the moment
   * the ADR-001 cascade removes its row.
   */
  async readUsage(scope: MeetingScope, monthStart: string): Promise<AccountUsage> {
    const rows = await this.sql<{ storage_bytes: string; month_seconds: string }[]>`
      SELECT COALESCE(SUM(audio_bytes), 0)::text AS storage_bytes,
             COALESCE(SUM(recorded_seconds) FILTER (WHERE created_at >= ${monthStart}), 0)::text
               AS month_seconds
        FROM meetings
       WHERE tenant_id = ${scope.tenantId}
         AND user_id = ${scope.userId}
    `;
    const row = rows[0];
    return {
      storageBytes: Number(row?.storage_bytes ?? 0),
      monthRecordedSeconds: Number(row?.month_seconds ?? 0),
    };
  }

  async listMeetings(scope: MeetingScope, options: ListMeetingsOptions = {}): Promise<Meeting[]> {
    const limit = Math.min(options.limit ?? DEFAULT_MEETING_LIMIT, MAX_MEETING_LIMIT);
    const offset = Math.max(options.offset ?? 0, 0);
    const search = options.search?.trim();

    // The search is a plain case-insensitive substring match on the title — enough for a V1
    // list of a user's own meetings, and honest about what it looks at. Searching transcript
    // text needs a real index and is its own ticket.
    const rows = await this.sql<MeetingRow[]>`
      SELECT id, session_id, title, audio_format, created_at, finalized_at
        FROM meetings
       WHERE tenant_id = ${scope.tenantId}
         AND user_id = ${scope.userId}
         ${search ? this.sql`AND title ILIKE ${"%" + escapeLike(search) + "%"}` : this.sql``}
       ORDER BY created_at DESC
       LIMIT ${limit} OFFSET ${offset}
    `;
    if (rows.length === 0) return [];

    const facts = await this.loadPipelineFacts(
      scope,
      rows.map((row) => row.id),
    );
    return rows.map((row) => toMeeting(row, facts));
  }

  async findMeeting(scope: MeetingScope, meetingId: string): Promise<MeetingDetailRow | null> {
    const rows = await this.sql<MeetingRow[]>`
      SELECT id, session_id, title, audio_format, created_at, finalized_at
        FROM meetings
       WHERE id = ${meetingId}
         AND tenant_id = ${scope.tenantId}
         AND user_id = ${scope.userId}
    `;
    const row = rows[0];
    if (!row) return null;

    const facts = await this.loadPipelineFacts(scope, [row.id]);
    const [transcript, summaries, jobs] = await this.loadArtifacts(scope, row.id);
    return { meeting: toMeeting(row, facts), transcript, summaries, jobs };
  }

  /**
   * Reads the derived-state facts for a batch of meetings.
   *
   * Three narrow statements rather than one query with lateral joins: each hits an existing
   * `(tenant_id, meeting_id)` index, and the whole block can be skipped when the worker has not
   * created its tables yet (see the catch below).
   */
  private async loadPipelineFacts(
    scope: MeetingScope,
    meetingIds: string[],
  ): Promise<PipelineFacts> {
    const empty: PipelineFacts = {
      transcripts: new Map(),
      summarized: new Set(),
      jobTypes: new Map(),
    };
    if (meetingIds.length === 0) return empty;

    try {
      const sql = this.sql;
      const transcriptRows = await sql<
        { meeting_id: string; language: string; duration_seconds: string | null }[]
      >`
        SELECT meeting_id,
               language,
               (SELECT max((segment->>'end')::double precision)
                  FROM jsonb_array_elements(transcript->'segments') segment) AS duration_seconds
          FROM transcripts
         WHERE tenant_id = ${scope.tenantId}
           AND is_active
           AND meeting_id IN ${sql(meetingIds)}
      `;
      const summaryRows = await sql<{ meeting_id: string }[]>`
        SELECT DISTINCT meeting_id
          FROM summaries
         WHERE tenant_id = ${scope.tenantId}
           AND is_active
           AND meeting_id IN ${sql(meetingIds)}
      `;
      const jobRows = await sql<
        {
          meeting_id: string;
          type: string;
          status: string;
          progress: number | null;
          error: { code: string; message: string } | null;
          created_at: Date;
        }[]
      >`
        SELECT meeting_id, type, status, progress, error, created_at
          FROM jobs
         WHERE tenant_id = ${scope.tenantId}
           AND meeting_id IN ${sql(meetingIds)}
         ORDER BY created_at ASC
      `;

      const facts: PipelineFacts = {
        transcripts: new Map(),
        summarized: new Set(),
        jobTypes: new Map(),
      };
      for (const row of transcriptRows) {
        facts.transcripts.set(row.meeting_id, {
          language: row.language,
          durationSeconds: row.duration_seconds === null ? null : Number(row.duration_seconds),
        });
      }
      for (const row of summaryRows) facts.summarized.add(row.meeting_id);
      for (const row of jobRows) {
        const stage: StageState = {
          status: row.status as StageState["status"],
          progress: row.progress,
          error: row.error,
        };
        const byType = facts.jobTypes.get(row.meeting_id) ?? new Map<string, StageState>();
        // Ascending order means the last row of a type wins — the most recent attempt.
        byType.set(row.type, stage);
        facts.jobTypes.set(row.meeting_id, byType);
      }
      return facts;
    } catch (error) {
      // The pipeline tables belong to the worker and are created when it starts. A server that
      // comes up first still serves its meeting list — every meeting simply reports the state it
      // has, which before any worker ran is exactly `recording` or `queued`.
      if (isUndefinedTable(error)) return empty;
      throw error;
    }
  }

  /** Loads the documents behind meeting detail. Missing pipeline tables read as "nothing yet". */
  private async loadArtifacts(
    scope: MeetingScope,
    meetingId: string,
  ): Promise<[Transcript | null, Summary[], Job[]]> {
    try {
      const transcriptRows = await this.sql<{ transcript: unknown }[]>`
        SELECT transcript FROM transcripts
         WHERE meeting_id = ${meetingId} AND tenant_id = ${scope.tenantId} AND is_active
      `;
      const summaryRows = await this.sql<{ summary: unknown }[]>`
        SELECT summary FROM summaries
         WHERE meeting_id = ${meetingId} AND tenant_id = ${scope.tenantId} AND is_active
         ORDER BY created_at ASC
      `;
      const jobRows = await this.sql<Record<string, unknown>[]>`
        SELECT id, meeting_id, type, status, progress, error, result_id,
               created_at, started_at, finished_at
          FROM jobs
         WHERE meeting_id = ${meetingId} AND tenant_id = ${scope.tenantId}
         ORDER BY created_at ASC
      `;

      const transcript = parseOrNull(TranscriptSchema, transcriptRows[0]?.transcript);
      const summaries = summaryRows
        .map((row) => parseOrNull(SummarySchema, row.summary))
        .filter((value): value is Summary => value !== null);
      const jobs = jobRows
        .map((row) =>
          parseOrNull(JobSchema, {
            id: row.id,
            meetingId: row.meeting_id,
            type: row.type,
            status: row.status,
            progress: row.progress,
            error: row.error,
            resultId: row.result_id,
            createdAt: toIso(row.created_at),
            startedAt: toIso(row.started_at),
            finishedAt: toIso(row.finished_at),
          }),
        )
        .filter((value): value is Job => value !== null);
      return [transcript, summaries, jobs];
    } catch (error) {
      if (isUndefinedTable(error)) return [null, [], []];
      throw error;
    }
  }

  /**
   * The database half of the ADR-001 cascade, in one transaction.
   *
   * Ownership is established by `SELECT ... FOR UPDATE` inside the same transaction, so a delete
   * cannot race a concurrent finalize, and a meeting outside the caller's scope simply matches
   * nothing — the statement never sees another tenant's rows.
   *
   * The pipeline tables are the worker's, and they may not exist yet on a server that came up
   * first; each is checked before it is touched, because inside a transaction a failed statement
   * takes the whole cascade with it.
   */
  async deleteMeeting(scope: MeetingScope, meetingId: string): Promise<boolean> {
    return this.sql.begin(async (sql) => {
      const owned = await sql<{ id: string }[]>`
        SELECT id FROM meetings
         WHERE id = ${meetingId}
           AND tenant_id = ${scope.tenantId}
           AND user_id = ${scope.userId}
         FOR UPDATE
      `;
      if (owned.length === 0) return false;

      // Summaries reference transcripts, so they go first even though no foreign key enforces it
      // yet — the order is the one a constraint would demand.
      for (const table of ["summaries", "transcripts", "jobs"] as const) {
        if (!(await tableExists(sql, "public", table))) continue;
        await sql`
          DELETE FROM ${sql(table)}
           WHERE meeting_id = ${meetingId} AND tenant_id = ${scope.tenantId}
        `;
      }

      await this.deleteQueuedWork(sql, meetingId);

      await sql`
        DELETE FROM meetings
         WHERE id = ${meetingId}
           AND tenant_id = ${scope.tenantId}
           AND user_id = ${scope.userId}
      `;
      return true;
    });
  }

  /**
   * Drops work still sitting in the queue for this meeting.
   *
   * This reaches into pg-boss's own tables, which is a deliberate exception: a `transcribe` job
   * left in the queue would be picked up after the delete and write a fresh transcript for a
   * meeting that no longer exists — data coming back from the dead is exactly what ADR-001 rules
   * out. pg-boss offers no "delete by payload" API, and the payload shape is ours
   * (`{ job: { meetingId } }`, see the queue adapters), so the filter is on our own data.
   */
  private async deleteQueuedWork(sql: postgres.TransactionSql, meetingId: string): Promise<void> {
    for (const table of ["job", "archive"] as const) {
      if (!(await tableExists(sql, "pgboss", table))) continue;
      await sql`
        DELETE FROM ${sql("pgboss")}.${sql(table)}
         WHERE data->'job'->>'meetingId' = ${meetingId}
      `;
    }
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}

/** Existence check that is safe inside a transaction, unlike letting the statement fail. */
async function tableExists(
  sql: postgres.TransactionSql,
  schema: string,
  table: string,
): Promise<boolean> {
  const rows = await sql<{ exists: boolean }[]>`
    SELECT to_regclass(${`${schema}.${table}`}) IS NOT NULL AS exists
  `;
  return rows[0]?.exists === true;
}

function toMeeting(row: MeetingRow, facts: PipelineFacts): Meeting {
  const transcript = facts.transcripts.get(row.id) ?? null;
  const byType = facts.jobTypes.get(row.id);
  const finalizedAt = row.finalized_at === null ? null : row.finalized_at.toISOString();

  const state = deriveMeetingState({
    finalizedAt,
    transcribe: byType?.get("transcribe") ?? null,
    summarize: byType?.get("summarize") ?? null,
    hasTranscript: transcript !== null,
    hasSummary: facts.summarized.has(row.id),
  });

  return {
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    status: state.status,
    audioFormat: row.audio_format,
    createdAt: row.created_at.toISOString(),
    finalizedAt,
    durationSeconds: transcript?.durationSeconds ?? null,
    language: transcript?.language ?? null,
    progress: state.progress,
    hasAudio: finalizedAt !== null,
    failure: state.failure,
  };
}

/**
 * A stored document that no longer matches its schema is reported as absent rather than
 * failing the whole response: one unreadable summary must not take a meeting offline.
 */
function parseOrNull<T>(
  schema: { safeParse(value: unknown): { success: boolean; data?: T } },
  value: unknown,
): T | null {
  if (value === null || value === undefined) return null;
  const parsed = schema.safeParse(value);
  return parsed.success && parsed.data !== undefined ? parsed.data : null;
}

function toIso(value: unknown): string | null {
  return value instanceof Date ? value.toISOString() : null;
}

/** Escapes the wildcards of a `LIKE` pattern so a search for "100%" matches a literal one. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function isUndefinedTable(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === UNDEFINED_TABLE;
}
