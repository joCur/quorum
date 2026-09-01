import { PgBoss } from "pg-boss";
import postgres from "postgres";
import { JobSchema, type Job } from "@quorum/shared";
import type { JobQueue } from "../types.js";
import { fairnessPriority } from "./fairness.js";

/**
 * How many jobs a user already has waiting on a queue.
 *
 * A port rather than a query inlined below, so the fairness decision can be exercised without a
 * database and so the one place that reaches into pg-boss's own tables is explicit.
 */
export type PendingJobCounter = (
  queue: string,
  scope: { tenantId: string; userId: string },
) => Promise<number>;

/**
 * Counts a user's waiting jobs directly in pg-boss's job table.
 *
 * Reaching into those tables is a deliberate, narrow exception — the same one the meeting deletion
 * cascade already makes — because pg-boss has no "count by payload" API and the payload shape
 * (`{ tenantId, userId }`, see below) is ours. Only rows that have not started yet are counted:
 * a job already running is no longer competing for a slot.
 */
export function createPendingJobCounter(connectionString: string): PendingJobCounter {
  const sql = postgres(connectionString, { max: 1 });
  return async (queue, scope) => {
    const rows = await sql<{ pending: string }[]>`
      SELECT count(*)::text AS pending
        FROM pgboss.job
       WHERE name = ${queue}
         AND state IN ('created', 'retry')
         AND data->>'tenantId' = ${scope.tenantId}
         AND data->>'userId' = ${scope.userId}
    `;
    return Number(rows[0]?.pending ?? 0);
  };
}

/** Queue name consumed by the transcription worker. */
export const TRANSCRIBE_QUEUE = "transcribe";

/** Queue name consumed by the summary worker. */
export const SUMMARIZE_QUEUE = "summarize";

/**
 * What every job payload carries: the `Job` from `shared/src/job.ts` plus the
 * tenant/user/session scope the worker needs to locate the audio in object
 * storage (ADR-001 scoping).
 */
export interface JobPayloadScope {
  job: Job;
  tenantId: string;
  userId: string;
  sessionId: string;
}

/**
 * Payload placed on the transcription queue.
 *
 * `language` is what the user side of the chain resolved to — the meeting's own
 * choice, or the user's default — and `null` when neither said anything. The
 * worker completes it with the deployment default and then autodetect. It
 * travels here rather than being looked up when the job runs, so a retry
 * transcribes what was asked for at the time.
 */
export interface TranscribeJobPayload extends JobPayloadScope {
  language: string | null;
}

/**
 * Payload on the summary queue. Same scope as above, plus the transcript to
 * summarize and the template to use.
 *
 * The transcript id travels in the payload rather than being looked up from the
 * meeting, because meeting -> transcript is 1:n (ADR-003 section 3): a summary
 * must name the exact transcript it was derived from, not "whichever is active
 * now". The worker validates this shape on the way in.
 */
export interface SummarizeJobPayload extends JobPayloadScope {
  transcriptId: string;
  templateId: string;
}

/**
 * Thin pg-boss binding (ADR-006 §3) — enqueue only. Consuming and job state
 * transitions belong to the worker ticket.
 */
export class PgBossJobQueue implements JobQueue {
  private readonly boss: PgBoss;
  private readonly countPending: PendingJobCounter | undefined;
  private started = false;

  constructor(bossOrConnectionString: PgBoss | string, countPending?: PendingJobCounter) {
    this.boss =
      typeof bossOrConnectionString === "string"
        ? new PgBoss({ connectionString: bossOrConnectionString })
        : bossOrConnectionString;
    this.countPending = countPending;
  }

  /**
   * Priority for a new job of this user, so one user cannot monopolize the GPU workers.
   *
   * A counting failure is not allowed to cost the recording its transcription: the job is then
   * enqueued at the neutral priority, which is what it would have had without fairness at all.
   */
  private async priorityFor(
    queue: string,
    scope: { tenantId: string; userId: string },
  ): Promise<number> {
    if (!this.countPending) return 0;
    try {
      return fairnessPriority(await this.countPending(queue, scope));
    } catch {
      return 0;
    }
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.boss.start();
    await this.boss.createQueue(TRANSCRIBE_QUEUE);
    await this.boss.createQueue(SUMMARIZE_QUEUE);
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.boss.stop();
    this.started = false;
  }

  async enqueueTranscribe(input: {
    jobId: string;
    meetingId: string;
    tenantId: string;
    userId: string;
    sessionId: string;
    language: string | null;
  }): Promise<void> {
    const job = JobSchema.parse({
      id: input.jobId,
      meetingId: input.meetingId,
      type: "transcribe",
      status: "queued",
      progress: null,
      error: null,
      resultId: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
    });
    const payload: TranscribeJobPayload = {
      job,
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: input.sessionId,
      language: input.language,
    };
    const priority = await this.priorityFor(TRANSCRIBE_QUEUE, {
      tenantId: input.tenantId,
      userId: input.userId,
    });
    // The job id is used as the pg-boss singleton key so a retried
    // `session.end` cannot enqueue the same transcription twice.
    await this.boss.send(TRANSCRIBE_QUEUE, payload, { singletonKey: input.jobId, priority });
  }

  /**
   * WHY THE JOB ID IS NOT DERIVED HERE: the pipeline derives its summarize job
   * id from the transcript and the template so that a replayed transcribe job
   * cannot buy a second model call. A regenerate is the opposite situation — the
   * user is deliberately asking for the same transcript and template to be run
   * again, usually after editing the template — so a derived id would make the
   * second request a silent no-op. The caller mints a fresh id per request and
   * refuses a second one while a summary for that meeting is still running, which
   * is the protection that actually belongs here.
   */
  async enqueueSummarize(input: {
    jobId: string;
    meetingId: string;
    tenantId: string;
    userId: string;
    sessionId: string;
    transcriptId: string;
    templateId: string;
    createdAt: string;
  }): Promise<void> {
    const job = JobSchema.parse({
      id: input.jobId,
      meetingId: input.meetingId,
      type: "summarize",
      status: "queued",
      progress: null,
      error: null,
      resultId: null,
      createdAt: input.createdAt,
      startedAt: null,
      finishedAt: null,
    });
    const payload: SummarizeJobPayload = {
      job,
      tenantId: input.tenantId,
      userId: input.userId,
      sessionId: input.sessionId,
      transcriptId: input.transcriptId,
      templateId: input.templateId,
    };
    const priority = await this.priorityFor(SUMMARIZE_QUEUE, {
      tenantId: input.tenantId,
      userId: input.userId,
    });
    await this.boss.send(SUMMARIZE_QUEUE, payload, { singletonKey: input.jobId, priority });
  }
}
