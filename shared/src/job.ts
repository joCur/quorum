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
  /**
   * The recording is larger than the transcription backend accepts in one request.
   *
   * Its own code rather than another rejection, because it is the one refusal of that family
   * that is about the recording: the same bytes will be too large for the same backend next
   * time, so nothing an operator or a user does changes the outcome.
   */
  "AUDIO_TOO_LARGE",
  /** Backend unreachable, overloaded or failing — worth another attempt. */
  "TRANSCRIPTION_UNAVAILABLE",
  /** Backend rejected the request: a model it does not serve, or a credential it will not take. */
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

/**
 * Codes a job may be asked to run again after — the per-code half of the split described above,
 * for the two sides outside the pipeline that have to make it: the API, which refuses to
 * re-enqueue a job whose failure nothing could undo, and the client, which does not offer an
 * action that is guaranteed to be refused.
 *
 * THE LINE IS WHAT THE FAILURE IS ABOUT. A failure about the recording or the job's own input —
 * a session that was never finalized, an empty recording, bytes no decoder accepts, audio larger
 * than the backend takes, a payload we do not understand — is permanent by nature: the input does
 * not change, so neither does the outcome. Everything else is about the machinery around it, and
 * machinery is exactly what changes between two attempts: object storage recovers, a database
 * blip passes, a backend finishes loading its model, an operator installs the model it was
 * missing or replaces the credential it was refusing.
 *
 * WHERE THIS IS MORE GENEROUS THAN `worker/src/errors.ts`, AND WHY. The pipeline dead-letters
 * `TRANSCRIPTION_REJECTED` and `TRANSCRIPTION_RESPONSE_INVALID` on the first attempt, because
 * nothing has changed between one automatic attempt and the next and repeating them immediately
 * only spends the budget. Both describe the backend rather than the recording, though — the
 * runbook's own note is that a persistent `TRANSCRIPTION_REJECTED` is almost always a model that
 * is not installed — and a person asking again, later, is saying that something has changed
 * since. Refusing them would leave the most common recoverable failure in this system with no
 * recovery but an operator redrive, which is the gap this predicate exists to close. What made
 * that split safe to draw is `AUDIO_TOO_LARGE`: the one refusal in that family that no operator
 * can fix now has a code of its own, so offering the rest is not offering a dead end.
 *
 * ONLY THE TRANSCRIPTION SIDE IS GENEROUS. The summary codes answer exactly what the pipeline
 * answers, and deliberately so: a summary attempt is a paid API call, `SUMMARY_REJECTED` covers
 * an oversized prompt that would burn the same tokens for the same answer, and nothing consumes
 * a summary retry yet. Pre-deciding it here would be guessing at a cost question on behalf of a
 * feature that does not exist.
 *
 * Per code rather than per attempt, because a stored job row keeps only the code. Where the
 * pipeline throws one code both ways — `AUDIO_FETCH_FAILED` covers an unreachable object store
 * and a chunk the manifest promised but storage does not have — the generous answer wins: a
 * refused retry is a dead end, while a retry that fails again costs one attempt and says what it
 * said before.
 */
const RETRYABLE_JOB_ERROR_CODES: ReadonlySet<string> = new Set<JobErrorCode>([
  "AUDIO_FETCH_FAILED",
  "TRANSCRIPTION_UNAVAILABLE",
  "TRANSCRIPTION_REJECTED",
  "TRANSCRIPTION_RESPONSE_INVALID",
  "TRANSCRIPT_PERSIST_FAILED",
  "SUMMARY_UNAVAILABLE",
  "SUMMARY_PERSIST_FAILED",
  "INTERNAL_ERROR",
]);

/**
 * True when a job that failed with this code is worth running again.
 *
 * Takes a plain string for the same reason `Job.error.code` is one: a code this build does not
 * know comes from a newer pipeline, and the honest answer about a failure nobody here can explain
 * is that repeating it is not known to help.
 */
export function isRetryableJobErrorCode(code: string): boolean {
  return RETRYABLE_JOB_ERROR_CODES.has(code);
}

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
