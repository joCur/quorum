import { z } from "zod";
import { AudioFormatSchema } from "./recording-protocol.js";
import { JobSchema } from "./job.js";
import { SummarySchema } from "./summary.js";
import { TranscriptSchema } from "./transcript.js";

/**
 * Meeting API contracts (ADR-001 scoping, ADR-002 job model).
 *
 * A meeting is the user-facing unit: one recording session plus everything derived from it.
 * The pipeline state is not stored on the meeting — it is derived on read from the recording
 * session, the job rows and the presence of a transcript and a summary. Deriving it keeps a
 * single writer per fact and means a meeting can never disagree with its own artifacts.
 */

/**
 * Condensed pipeline state shown as the list badge.
 *
 * `summarizing` deliberately covers both "the summary job is queued" and "it is running":
 * the summary is enqueued by the transcription worker after the transcript is stored, so
 * between those two moments no summarize job row exists yet. Reporting that gap as
 * `summarizing` rather than as an absence keeps the badge truthful without a placeholder row.
 */
export const MeetingStatusSchema = z.enum([
  /** Session started, no manifest yet — the recording is still open. */
  "recording",
  /** Finalized, transcription has not started. */
  "queued",
  "transcribing",
  "summarizing",
  /** Transcript and summary are stored. */
  "ready",
  "failed",
]);

/**
 * Which pipeline stage failed, for the error panel in meeting detail.
 *
 * `code` is what the panel is rendered from — one of `JOB_ERROR_CODES`, turned into a translated
 * sentence by the client. `message` is the pipeline's own English description, kept for logs and
 * support tooling and deliberately never shown to a user: it may quote a backend verbatim, which
 * ADR-005 keeps out of the UI.
 */
export const MeetingFailureSchema = z.object({
  stage: z.enum(["transcribe", "summarize"]),
  code: z.string(),
  message: z.string(),
});

export const MeetingSchema = z.object({
  id: z.string().uuid(),
  sessionId: z.string().uuid(),
  /**
   * What the meeting is called: the title the user gave it, or — for a recording they left
   * unnamed — the one the summary suggested (`meeting-title.ts`). Null until either exists.
   */
  title: z.string().nullable(),
  status: MeetingStatusSchema,
  audioFormat: AudioFormatSchema,
  createdAt: z.string().datetime(),
  /** Set once the recording was finalized; null while it is still open. */
  finalizedAt: z.string().datetime().nullable(),
  /** Audio length in seconds, known once a transcript exists. */
  durationSeconds: z.number().nonnegative().nullable(),
  /** BCP-47 language of the active transcript, once there is one. */
  language: z.string().nullable(),
  /** Progress 0..1 of the stage currently running, when the worker reports numbers. */
  progress: z.number().min(0).max(1).nullable(),
  /** True once the recording was finalized, i.e. the audio can be played back. */
  hasAudio: z.boolean(),
  failure: MeetingFailureSchema.nullable(),
});

export const MeetingListSchema = z.object({
  meetings: z.array(MeetingSchema),
});

/**
 * Everything the meeting detail screen renders in one response: the meeting, its active
 * transcript, its active summaries (one per template, ADR-004 §3) and the job rows behind the
 * pipeline stepper.
 */
export const MeetingDetailSchema = z.object({
  meeting: MeetingSchema,
  /** The active transcript with the user's corrections already applied (ADR-010 §3). */
  transcript: TranscriptSchema.nullable(),
  summaries: z.array(SummarySchema),
  jobs: z.array(JobSchema),
  /**
   * When the active transcript was last corrected, or null when it never was.
   *
   * It is a fact about the transcript but it does not live on the transcript document, which the
   * transcription worker owns and nobody else writes (ADR-010 §1). The summary view compares it
   * against a summary's `createdAt` to say that the transcript moved on since.
   */
  transcriptCorrectedAt: z.string().datetime().nullable().default(null),
});

/**
 * Renaming a meeting.
 *
 * `title` is required but may be empty: clearing the field is a thing a user means to do, and it
 * returns the meeting to unnamed — which the next summary may fill again, exactly as it would
 * have for a recording that was never named. An absent field is a malformed request rather than
 * "leave it alone", so a client cannot clear a title by forgetting to send one.
 *
 * The bound is generous compared to what a generated title may be: a person naming their own
 * meeting is not the party this cap is protecting the list from.
 */
export const MAX_MEETING_TITLE_LENGTH = 200;

export const RenameMeetingRequestSchema = z.object({
  title: z.string().max(MAX_MEETING_TITLE_LENGTH),
});

export type MeetingStatus = z.infer<typeof MeetingStatusSchema>;
export type RenameMeetingRequest = z.infer<typeof RenameMeetingRequestSchema>;
export type MeetingFailure = z.infer<typeof MeetingFailureSchema>;
export type Meeting = z.infer<typeof MeetingSchema>;
export type MeetingList = z.infer<typeof MeetingListSchema>;
export type MeetingDetail = z.infer<typeof MeetingDetailSchema>;
