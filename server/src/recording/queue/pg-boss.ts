import { PgBoss } from "pg-boss";
import { JobSchema, type Job } from "@quorum/shared";
import type { JobQueue } from "../types.js";

/** Queue name consumed by the transcription worker. */
export const TRANSCRIBE_QUEUE = "transcribe";

/** Queue name consumed by the summary worker. */
export const SUMMARIZE_QUEUE = "summarize";

/**
 * Payload placed on the queue: the `Job` from `shared/src/job.ts` plus the
 * tenant/user/session scope the worker needs to locate the audio in object
 * storage (ADR-001 scoping).
 */
export interface TranscribeJobPayload {
  job: Job;
  tenantId: string;
  userId: string;
  sessionId: string;
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
export interface SummarizeJobPayload extends TranscribeJobPayload {
  transcriptId: string;
  templateId: string;
}

/**
 * Thin pg-boss binding (ADR-006 §3) — enqueue only. Consuming and job state
 * transitions belong to the worker ticket.
 */
export class PgBossJobQueue implements JobQueue {
  private readonly boss: PgBoss;
  private started = false;

  constructor(bossOrConnectionString: PgBoss | string) {
    this.boss =
      typeof bossOrConnectionString === "string"
        ? new PgBoss({ connectionString: bossOrConnectionString })
        : bossOrConnectionString;
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
    };
    // The job id is used as the pg-boss singleton key so a retried
    // `session.end` cannot enqueue the same transcription twice.
    await this.boss.send(TRANSCRIBE_QUEUE, payload, { singletonKey: input.jobId });
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
    await this.boss.send(SUMMARIZE_QUEUE, payload, { singletonKey: input.jobId });
  }
}
