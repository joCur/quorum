import type { PgBoss } from "pg-boss";
import { JobSchema } from "@quorum/shared";
import { remuxJobIdFor } from "../ids.js";
import { REMUX_QUEUE, type RemuxJobPayload } from "../payload.js";

export interface EnqueueRemuxInput {
  meetingId: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  /** Playing time the transcription measured; the remux checks its own answer against it. */
  expectedDurationSeconds: number | null;
  createdAt: string;
}

/** Port so the transcribe handler can be tested without a queue. */
export interface RemuxEnqueuer {
  enqueue(input: EnqueueRemuxInput): Promise<void>;
}

/** The payload a given session produces — pure, so the tests can assert on it. */
export function remuxJobPayload(input: EnqueueRemuxInput): RemuxJobPayload {
  const job = JobSchema.parse({
    id: remuxJobIdFor(input.sessionId),
    meetingId: input.meetingId,
    type: "remux",
    status: "queued",
    progress: null,
    error: null,
    resultId: null,
    createdAt: input.createdAt,
    startedAt: null,
    finishedAt: null,
  });
  return {
    job,
    tenantId: input.tenantId,
    userId: input.userId,
    sessionId: input.sessionId,
    expectedDurationSeconds: input.expectedDurationSeconds,
  };
}

/**
 * Hands a finished recording on to be repackaged (ADR-010).
 *
 * The job id is derived from the session and used as the pg-boss singleton key, so the several
 * ways a session can be transcribed more than once — a replay after a crash, a retry a user
 * asked for, an operator redriving a dead letter — cannot pile up several attempts at the same
 * repackaging. The handler is a no-op on an already-repackaged recording in any case; this only
 * keeps the queue from filling with jobs whose whole content is discovering that.
 */
export class PgBossRemuxEnqueuer implements RemuxEnqueuer {
  private readonly boss: PgBoss;

  constructor(boss: PgBoss) {
    this.boss = boss;
  }

  async enqueue(input: EnqueueRemuxInput): Promise<void> {
    const payload = remuxJobPayload(input);
    await this.boss.send(REMUX_QUEUE, payload, { singletonKey: payload.job.id });
  }
}
