import { z } from "zod";

/**
 * The async job API (ADR-002): create a job → status via polling/SSE → fetch the result.
 */

export const JobTypeSchema = z.enum([
  "transcribe",
  "summarize",
  // Later: "diarize", "reprocess"
]);

export const JobStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "canceled"]);

/**
 * Machine-readable reasons a transcription or summary job failed.
 *
 * The codes are the contract between the pipeline and the client: the pipeline's own `message` is
 * a developer-facing English sentence that may quote whatever a backend answered, so the client
 * renders the failure from the code through i18n instead (CLAUDE.md, ADR-005 — backend details
 * never reach the UI). The pipeline additionally decides per code whether an attempt is worth
 * repeating, which is why the list lives here rather than in either side alone.
 */
export const JOB_ERROR_CODES = [
  /** The session was never finalized, so there is nothing to transcribe. */
  "MANIFEST_NOT_FOUND",
  /** Object storage refused or failed a read. */
  "AUDIO_FETCH_FAILED",
  /** The manifest exists but references no chunk, or the chunks are empty. */
  "AUDIO_EMPTY",
  /** The transcription backend could not decode the audio it was given. */
  "AUDIO_DECODE_FAILED",
  /** Backend unreachable, overloaded or failing — worth another attempt. */
  "TRANSCRIPTION_UNAVAILABLE",
  /** Backend rejected the request (bad model name, unauthorized, too large). */
  "TRANSCRIPTION_REJECTED",
  /** Backend answered, but not in the OpenAI-compatible shape we require. */
  "TRANSCRIPTION_RESPONSE_INVALID",
  /** The mapped result does not satisfy the transcript schema. */
  "TRANSCRIPT_INVALID",
  /** Writing the transcript to PostgreSQL failed. */
  "TRANSCRIPT_PERSIST_FAILED",
  /** The job payload on the queue is not a payload we understand. */
  "JOB_PAYLOAD_INVALID",

  // ---- Summary pipeline (ADR-004, ADR-005) ----
  /** The transcript the summarize job refers to does not exist (any more). */
  "TRANSCRIPT_NOT_FOUND",
  /** The transcript carries no usable text, so there is nothing to summarize. */
  "TRANSCRIPT_EMPTY",
  /** The summarize job names a template that is not stored. */
  "SUMMARY_TEMPLATE_NOT_FOUND",
  /** Summary backend unreachable, overloaded or failing — worth another attempt. */
  "SUMMARY_UNAVAILABLE",
  /** Backend rejected the request (bad model name, unauthorized, too large). */
  "SUMMARY_REJECTED",
  /** The model answered, but not in the structure the template demands. */
  "SUMMARY_RESPONSE_INVALID",
  /** The mapped result does not satisfy the summary schema. */
  "SUMMARY_INVALID",
  /** Writing the summary to PostgreSQL failed. */
  "SUMMARY_PERSIST_FAILED",

  /** Anything we did not anticipate. */
  "INTERNAL_ERROR",
] as const;

export const JobErrorCodeSchema = z.enum(JOB_ERROR_CODES);

export const JobSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  type: JobTypeSchema,
  status: JobStatusSchema,
  /** 0..1, optional, for a progress indicator */
  progress: z.number().min(0).max(1).nullable().default(null),
  /**
   * A uniform error format across the whole API.
   *
   * `code` stays a plain string rather than the enum above: a pipeline that learns a new code
   * must not make its job rows unreadable to a client that predates it. Consumers narrow the
   * string against `JOB_ERROR_CODES` and treat anything else as a generic failure.
   */
  error: z
    .object({
      code: z.string(), // machine-readable, one of JOB_ERROR_CODES
      message: z.string(), // developer-facing English; never rendered to a user
    })
    .nullable()
    .default(null),
  /** A reference to the result, e.g. transcriptId or summaryId */
  resultId: z.string().uuid().nullable().default(null),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable().default(null),
  finishedAt: z.string().datetime().nullable().default(null),
});

export type Job = z.infer<typeof JobSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];
