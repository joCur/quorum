import { z } from "zod";
import { JobSchema } from "@quorum/shared";
import { JobError } from "./errors.js";

/** Queue name the recording endpoint enqueues on (ADR-006 §3). */
export const TRANSCRIBE_QUEUE = "transcribe";

/** Dead-letter queue for transcriptions that will never succeed. */
export const TRANSCRIBE_DEAD_LETTER_QUEUE = "transcribe-dead-letter";

/**
 * What the recording endpoint puts on the queue: the `Job` from
 * `shared/src/job.ts` plus the tenant/user/session scope needed to locate the
 * audio in object storage (ADR-001 scoping). Validated here because the two
 * processes are deployed independently.
 */
export const TranscribeJobPayloadSchema = z.object({
  job: JobSchema,
  tenantId: z.string().min(1),
  userId: z.string().min(1),
  sessionId: z.string().min(1),
});

export type TranscribeJobPayload = z.infer<typeof TranscribeJobPayloadSchema>;

export function parseTranscribeJobPayload(data: unknown): TranscribeJobPayload {
  const parsed = TranscribeJobPayloadSchema.safeParse(data);
  if (!parsed.success) {
    throw new JobError(
      "JOB_PAYLOAD_INVALID",
      `unusable transcribe payload: ${parsed.error.message}`,
      {
        retryable: false,
      },
    );
  }
  if (parsed.data.job.type !== "transcribe") {
    throw new JobError(
      "JOB_PAYLOAD_INVALID",
      `job type "${parsed.data.job.type}" does not belong on the transcribe queue`,
      { retryable: false },
    );
  }
  return parsed.data;
}

/** Queue the summary worker consumes; filled when a transcript is persisted. */
export const SUMMARIZE_QUEUE = "summarize";

/** Dead-letter queue for summaries that will never succeed. */
export const SUMMARIZE_DEAD_LETTER_QUEUE = "summarize-dead-letter";

/**
 * What the transcribe handler puts on the summary queue: the `Job` from
 * `shared/src/job.ts`, the same tenant/user/session scope, plus the transcript
 * to summarize and the template to use.
 *
 * The transcript id travels in the payload rather than being looked up from the
 * meeting, because meeting → transcript is 1:n (ADR-003 §3): a summary must
 * name the exact transcript it was derived from, not "whichever is active now".
 */
export const SummarizeJobPayloadSchema = z.object({
  job: JobSchema,
  tenantId: z.string().min(1),
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  transcriptId: z.string().uuid(),
  templateId: z.string().uuid(),
});

export type SummarizeJobPayload = z.infer<typeof SummarizeJobPayloadSchema>;

export function parseSummarizeJobPayload(data: unknown): SummarizeJobPayload {
  const parsed = SummarizeJobPayloadSchema.safeParse(data);
  if (!parsed.success) {
    throw new JobError(
      "JOB_PAYLOAD_INVALID",
      `unusable summarize payload: ${parsed.error.message}`,
      { retryable: false },
    );
  }
  if (parsed.data.job.type !== "summarize") {
    throw new JobError(
      "JOB_PAYLOAD_INVALID",
      `job type "${parsed.data.job.type}" does not belong on the summarize queue`,
      { retryable: false },
    );
  }
  return parsed.data;
}
