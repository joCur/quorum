import type { PgBoss } from "pg-boss";
import { JobSchema } from "@quorum/shared";
import { remuxJobIdFor } from "../ids.js";
import { REMUX_QUEUE, type RemuxJobPayload } from "../payload.js";

export interface EnqueueRemuxInput {
  meetingId: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  expectedDurationSeconds: number | null;
  createdAt: string;
}

/** Port so the transcribe handler can be tested without a queue. */
export interface RemuxEnqueuer {
  enqueue(input: EnqueueRemuxInput): Promise<void>;
}

export interface QueueInspector {
  hasLiveQueueEntry(queue: string, jobId: string): Promise<boolean>;
}

/** Exported and pure so the tests can assert on the payload without a queue. */
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
 * THE SINGLETON KEY DOES NOT DEDUPLICATE ANYTHING HERE, and it is worth being explicit about
 * that because the name suggests otherwise. Every unique index pg-boss creates for singleton
 * keys is predicated on a queue policy of `short`, `singleton`, `stately`, `exclusive` or
 * `key_strict_fifo`; these queues are created with `standard`, so two sends of the same key
 * become two live jobs. The key is passed anyway — it costs nothing, it is the right key, and it
 * would start working the day a policy changes — but nothing may be built on top of it.
 *
 * What makes a session's repackaging happen once is therefore the handler, not the queue. It is
 * written to be correct with a second copy of itself running against the same objects, and a run
 * that finds the work already done says so and stops. The derived id is still the right id: it
 * makes duplicates recognisable in the queue and keeps a redrive pointed at the same job.
 */
export class PgBossRemuxEnqueuer implements RemuxEnqueuer {
  private readonly boss: PgBoss;
  private readonly queue: QueueInspector | undefined;

  constructor(boss: PgBoss, queue?: QueueInspector) {
    this.boss = boss;
    this.queue = queue;
  }

  async enqueue(input: EnqueueRemuxInput): Promise<void> {
    const payload = remuxJobPayload(input);
    // Advisory, not a lock: two callers can both look and both send. It exists to keep the
    // ordinary case — a transcription that runs again while the first repackaging is still
    // queued — from putting a second job on the queue whose whole content would be reading the
    // recording to discover there is nothing to do.
    if (await this.queue?.hasLiveQueueEntry(REMUX_QUEUE, payload.job.id)) return;
    await this.boss.send(REMUX_QUEUE, payload, { singletonKey: payload.job.id });
  }
}
