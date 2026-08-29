import { PgBoss } from "pg-boss";
import { JobSchema, type Job } from "@quorum/shared";
import type { JobQueue } from "../types.js";

/** Queue name consumed by the transcription worker. */
export const TRANSCRIBE_QUEUE = "transcribe";

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
}
