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
