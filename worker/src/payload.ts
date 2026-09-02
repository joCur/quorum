import { z } from "zod";
import { JobSchema } from "@quorum/shared";
import { JobError } from "./errors.js";

/**
 * Sanity bounds, deliberately an order of magnitude above the product cap: repeating the real cap
 * here would dead-letter a good recording whenever a newer API stores a wider list than this
 * worker knows about. These only stop a malformed payload being unbounded work.
 */
const SANE_TERM_COUNT = 500;
const SANE_TERM_LENGTH = 200;

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
  /**
   * Language to transcribe in, as far as the API side of the chain could resolve it: the
   * meeting's own choice, or the user's default when the meeting made none. `auto` asks for
   * detection; `null` — and an absent field, which is what a job enqueued before this existed
   * looks like — leaves the deployment default and then autodetect to this side.
   *
   * Unlike the vocabulary below, this is re-resolved from the session record even for a retry the
   * user asks for: a language changed since the recording would decode it as the wrong thing.
   */
  language: z.string().nullable().default(null),
  /**
   * Absent — what a job enqueued before this existed looks like — is an empty list.
   *
   * Snapshotted rather than looked up at run time, so a redelivery of *this* job biases towards
   * what was configured when the recording was made. A retry the user asks for is deliberately
   * different: see the note in the API's transcription routes.
   */
  vocabulary: z.array(z.string().max(SANE_TERM_LENGTH)).max(SANE_TERM_COUNT).default([]),
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

/** Filled when a transcription succeeds, not when the recording is finalized (ADR-010). */
export const REMUX_QUEUE = "remux";

export const REMUX_DEAD_LETTER_QUEUE = "remux-dead-letter";

export const RemuxJobPayloadSchema = z.object({
  job: JobSchema,
  tenantId: z.string().min(1),
  userId: z.string().min(1),
  sessionId: z.string().min(1),
  /**
   * What the backend decoded, carried for the log line that compares it against the container's
   * own length. Advisory only — the silence filter makes the two legitimately differ, so nothing
   * is refused over it (`remux/handler.ts`).
   */
  expectedDurationSeconds: z.number().nonnegative().nullable().default(null),
});

export type RemuxJobPayload = z.infer<typeof RemuxJobPayloadSchema>;

export function parseRemuxJobPayload(data: unknown): RemuxJobPayload {
  const parsed = RemuxJobPayloadSchema.safeParse(data);
  if (!parsed.success) {
    throw new JobError("JOB_PAYLOAD_INVALID", `unusable remux payload: ${parsed.error.message}`, {
      retryable: false,
    });
  }
  if (parsed.data.job.type !== "remux") {
    throw new JobError(
      "JOB_PAYLOAD_INVALID",
      `job type "${parsed.data.job.type}" does not belong on the remux queue`,
      { retryable: false },
    );
  }
  return parsed.data;
}
