import {
  JOB_ERROR_CODES,
  type Job,
  type JobErrorCode,
  type MeetingDetail,
  type MeetingFailure,
} from "@quorum/shared";

/**
 * How a failed pipeline stage is named on screen.
 *
 * The pipeline's own `message` is written for whoever reads the logs: English, and free to quote
 * whatever a backend answered — down to a model name and an HTTP status. None of that belongs in
 * front of a user (CLAUDE.md, ADR-005), so the panel is rendered from the code alone and this map
 * is the single place that turns one into an i18n key.
 *
 * The map is exhaustive over the shared codes by type, so a code added to the contract cannot
 * reach the UI without copy of its own. Codes this build does not know — an older client meeting
 * a newer pipeline — fall back to the generic failure, which is true of any failure.
 */
const MESSAGE_KEYS = {
  MANIFEST_NOT_FOUND: "meeting.failure.recordingUnfinished",
  AUDIO_FETCH_FAILED: "meeting.failure.audioUnavailable",
  AUDIO_EMPTY: "meeting.failure.audioEmpty",
  AUDIO_DECODE_FAILED: "meeting.failure.audioUnreadable",
  AUDIO_TOO_LARGE: "meeting.failure.audioTooLong",
  TRANSCRIPTION_UNAVAILABLE: "meeting.failure.transcriptionUnavailable",
  TRANSCRIPTION_REJECTED: "meeting.failure.transcriptionFailed",
  TRANSCRIPTION_RESPONSE_INVALID: "meeting.failure.transcriptionFailed",
  TRANSCRIPT_INVALID: "meeting.failure.transcriptionFailed",
  TRANSCRIPT_PERSIST_FAILED: "meeting.failure.transcriptNotSaved",
  JOB_PAYLOAD_INVALID: "meeting.failure.generic",

  TRANSCRIPT_NOT_FOUND: "meeting.failure.transcriptMissing",
  TRANSCRIPT_EMPTY: "meeting.failure.transcriptEmpty",
  SUMMARY_TEMPLATE_NOT_FOUND: "meeting.failure.templateMissing",
  SUMMARY_UNAVAILABLE: "meeting.failure.summaryUnavailable",
  SUMMARY_REJECTED: "meeting.failure.summaryFailed",
  SUMMARY_RESPONSE_INVALID: "meeting.failure.summaryFailed",
  SUMMARY_INVALID: "meeting.failure.summaryFailed",
  SUMMARY_PERSIST_FAILED: "meeting.failure.summaryNotSaved",

  INTERNAL_ERROR: "meeting.failure.generic",
} as const satisfies Record<JobErrorCode, string>;

const GENERIC_KEY = "meeting.failure.generic";

const CODES: ReadonlySet<string> = new Set(JOB_ERROR_CODES);

export type FailureMessageKey = (typeof MESSAGE_KEYS)[JobErrorCode] | typeof GENERIC_KEY;

/** Narrows an arbitrary error code from a job row to one this build has copy for. */
export function asJobErrorCode(value: unknown): JobErrorCode | null {
  return typeof value === "string" && CODES.has(value) ? (value as JobErrorCode) : null;
}

/** The i18n key describing a failure. Literal, so the translation type checks it like any other. */
export function failureMessageKey(code: string): FailureMessageKey {
  const known = asJobErrorCode(code);
  return known === null ? GENERIC_KEY : MESSAGE_KEYS[known];
}

/**
 * The job behind a failed stage, for the support reference under the message.
 *
 * Null is a normal answer: the job rows are the pipeline's, and a stage can be reported as failed
 * from the meeting's own state before — or without — a row of its own being readable.
 */
export function failedJob(detail: MeetingDetail, stage: MeetingFailure["stage"]): Job | null {
  return detail.jobs.find((entry) => entry.type === stage && entry.status === "failed") ?? null;
}

/** Convenience over {@link failedJob} for the support reference the panel prints. */
export function failedJobId(detail: MeetingDetail, stage: MeetingFailure["stage"]): string | null {
  return failedJob(detail, stage)?.id ?? null;
}
