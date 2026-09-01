import type { PgBoss } from "pg-boss";
import { JobSchema } from "@quorum/shared";
import { summarizeJobIdFor } from "../ids.js";
import { SUMMARIZE_QUEUE, type SummarizeJobPayload } from "../payload.js";

export interface EnqueueSummaryInput {
  transcriptId: string;
  meetingId: string;
  templateId: string;
  tenantId: string;
  userId: string;
  sessionId: string;
  createdAt: string;
}

/** Port so the transcribe handler can be tested without a queue. */
export interface SummaryEnqueuer {
  enqueue(input: EnqueueSummaryInput): Promise<void>;
}

/** The payload a given transcript produces — pure, so the tests can assert on it. */
export function summarizeJobPayload(input: EnqueueSummaryInput): SummarizeJobPayload {
  const job = JobSchema.parse({
    id: summarizeJobIdFor(input.transcriptId, input.templateId),
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
  return {
    job,
    tenantId: input.tenantId,
    userId: input.userId,
    sessionId: input.sessionId,
    transcriptId: input.transcriptId,
    templateId: input.templateId,
  };
}

/**
 * Enqueues the summary job for a freshly persisted transcript.
 *
 * The job id is derived from the transcript and the template (see `ids.ts`), so
 * a replayed transcribe job lands on the id the first run's summary already
 * occupies. Requesting a summary of the same transcript with a *different*
 * template is a different id and is meant to create a second summary — meeting
 * → summary is 1:n (ADR-004 §3).
 *
 * WHAT THE SINGLETON KEY DOES NOT DO: deduplicate. The queue runs under
 * pg-boss's `standard` policy, and none of the unique indexes behind
 * `singletonKey` applies to that policy, so a second send of the same id
 * inserts a second entry. The key is there to make every entry for one job
 * findable. What keeps a replay from paying for a second model call is the
 * summarize handler, which looks for a summary already stored under its own job
 * id before it says anything to the backend.
 */
export class PgBossSummaryEnqueuer implements SummaryEnqueuer {
  constructor(private readonly boss: PgBoss) {}

  async enqueue(input: EnqueueSummaryInput): Promise<void> {
    const payload = summarizeJobPayload(input);
    // A declined send answers with a null id rather than an error. The transcribe handler makes
    // a point of logging an enqueue failure loudly instead of losing it, so it has to be told.
    const queueJobId = await this.boss.send(SUMMARIZE_QUEUE, payload, {
      singletonKey: payload.job.id,
    });
    if (queueJobId === null) {
      throw new Error(`the ${SUMMARIZE_QUEUE} queue did not accept job ${payload.job.id}`);
    }
  }
}
