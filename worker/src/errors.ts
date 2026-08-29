/**
 * Error taxonomy for the transcription pipeline.
 *
 * `code` is the machine-readable value that ends up in `Job.error.code`
 * (`shared/src/job.ts`); `retryable` decides whether pg-boss gets another
 * attempt or the job is dead-lettered immediately. The split matters
 * operationally: a Whisper backend that is still booting must be retried, an
 * audio file the backend cannot decode never will be.
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
  /** The job payload on the queue is not a transcribe payload we understand. */
  "JOB_PAYLOAD_INVALID",
  /** Anything we did not anticipate. */
  "INTERNAL_ERROR",
] as const;

export type JobErrorCode = (typeof JOB_ERROR_CODES)[number];

export class JobError extends Error {
  readonly code: JobErrorCode;
  readonly retryable: boolean;

  constructor(
    code: JobErrorCode,
    message: string,
    options: { retryable: boolean; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "JobError";
    this.code = code;
    this.retryable = options.retryable;
  }
}

/** Normalizes anything thrown inside a job into a `JobError`. */
export function toJobError(error: unknown): JobError {
  if (error instanceof JobError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new JobError("INTERNAL_ERROR", message, { retryable: true, cause: error });
}

/**
 * Maps an HTTP status from the transcription backend onto our taxonomy.
 *
 * 400/415/422 mean the backend looked at the bytes and refused them — retrying
 * the same bytes cannot help, so those become a terminal decode failure. 408,
 * 429 and every 5xx are transient by nature.
 */
export function errorCodeForHttpStatus(status: number): { code: JobErrorCode; retryable: boolean } {
  if (status === 400 || status === 415 || status === 422) {
    return { code: "AUDIO_DECODE_FAILED", retryable: false };
  }
  if (status === 408 || status === 429 || status >= 500) {
    return { code: "TRANSCRIPTION_UNAVAILABLE", retryable: true };
  }
  return { code: "TRANSCRIPTION_REJECTED", retryable: false };
}
