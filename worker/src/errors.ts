import { JOB_ERROR_CODES, type JobErrorCode } from "@quorum/shared";

/**
 * Error handling for the transcription and summary pipelines.
 *
 * The taxonomy itself lives in `shared/src/job.ts`, because it is a contract
 * rather than an internal detail: the code ends up in `Job.error.code` and the
 * client turns it into the sentence the user reads. What belongs here is the
 * operational half — `retryable` decides whether pg-boss gets another attempt
 * or the job is dead-lettered immediately. That split matters: a Whisper
 * backend that is still booting must be retried, an audio file the backend
 * cannot decode never will be.
 *
 * A related but deliberately different question is answered per code by
 * `isRetryableJobErrorCode` in `shared/src/job.ts`: whether a *person* asking
 * for the job again, later, could get a different answer. The flags here decide
 * what to do now, with nothing changed; that one decides what to offer someone
 * who is saying something has. They agree everywhere except on the codes that
 * describe the backend's configuration — see the note over there — and a code
 * given a new verdict on either side wants a look at the other, and at the
 * table in `docs/runbooks/pipeline.md` that documents this one.
 */
export { JOB_ERROR_CODES, type JobErrorCode };

/**
 * Not a failure: the meeting was deleted while this job was running.
 *
 * The deletion cascade (ADR-001) drops the work still queued for a meeting, but
 * a job that is already active survives that sweep and would otherwise persist
 * a transcript or a summary for a meeting that no longer exists — data coming
 * back from the dead, which the deletion promise rules out. Both handlers
 * therefore verify the meeting immediately before the write and raise this
 * instead.
 *
 * It is deliberately not a `JobError`: there is no code worth reporting, no
 * retry that could change the outcome and nothing to dead-letter. The job is
 * abandoned — quietly and terminally.
 */
export class MeetingGoneError extends Error {
  readonly meetingId: string;

  constructor(meetingId: string) {
    super(`meeting ${meetingId} no longer exists; the job result was discarded`);
    this.name = "MeetingGoneError";
    this.meetingId = meetingId;
  }
}

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
 *
 * 413 gets a code of its own rather than joining the general rejection, and the
 * reason is on the far side of the API: a rejection is offered to the user as
 * "try again", because it is usually a model the backend does not have and an
 * operator can install it. A recording too large for that backend is the one
 * member of the family nobody can fix, so it must not wear the same code — it
 * would turn the retry into a button that can only ever fail.
 */
export function errorCodeForHttpStatus(status: number): { code: JobErrorCode; retryable: boolean } {
  if (status === 400 || status === 415 || status === 422) {
    return { code: "AUDIO_DECODE_FAILED", retryable: false };
  }
  if (status === 413) {
    return { code: "AUDIO_TOO_LARGE", retryable: false };
  }
  if (status === 408 || status === 429 || status >= 500) {
    return { code: "TRANSCRIPTION_UNAVAILABLE", retryable: true };
  }
  return { code: "TRANSCRIPTION_REJECTED", retryable: false };
}

/**
 * Maps an HTTP status from the summary backend onto our taxonomy.
 *
 * The split differs from transcription in one place that matters for cost:
 * 413 ("context/payload too large") is terminal, because sending the same
 * oversized prompt again burns tokens for the same answer. Rate limits (429),
 * timeouts (408) and 5xx are the transient cases a hosted router produces under
 * load, and a self-hosted endpoint produces while it loads a model.
 */
export function summaryErrorCodeForHttpStatus(status: number): {
  code: JobErrorCode;
  retryable: boolean;
} {
  if (status === 408 || status === 429 || status >= 500) {
    return { code: "SUMMARY_UNAVAILABLE", retryable: true };
  }
  return { code: "SUMMARY_REJECTED", retryable: false };
}
