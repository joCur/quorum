import type { JobStatus, MeetingFailure, MeetingStatus } from "@quorum/shared";

/** The job facts the status derivation needs, per pipeline stage. */
export interface StageState {
  status: JobStatus;
  progress: number | null;
  error: { code: string; message: string } | null;
}

export interface MeetingStateInput {
  /** Null while the recording is still open — no manifest has been written yet. */
  finalizedAt: string | null;
  /** The `transcribe` job row, or null when the worker has not picked the job up yet. */
  transcribe: StageState | null;
  /** The `summarize` job row, or null before the worker enqueues and picks it up. */
  summarize: StageState | null;
  hasTranscript: boolean;
  hasSummary: boolean;
}

export interface MeetingState {
  status: MeetingStatus;
  progress: number | null;
  failure: MeetingFailure | null;
}

/**
 * Derives the badge state of a meeting from the recording and the pipeline rows.
 *
 * TWO ENQUEUE GAPS ARE CLOSED HERE, both by deriving rather than by writing a placeholder row:
 *
 * 1. Between `session.end` and the transcription worker picking the job up there is no job row,
 *    because the worker writes it when it starts. A finalized meeting without a transcribe row
 *    is therefore reported as `queued` — which is exactly what it is.
 * 2. The summarize job row appears only once the summary worker starts. A stored transcript
 *    without a summary is reported as `summarizing`, covering both the queue wait and the run.
 *
 * The alternative — having the enqueuing side write a `queued` row — would put a second writer
 * on the job table for a state that is fully implied by the rows that already exist. The retry
 * endpoint is the single exception, and it is one precisely because the state is *not* implied
 * there: see `server/src/transcription/routes.ts`.
 *
 * WORK IN FLIGHT OUTRANKS WHAT AN EARLIER RUN LEFT BEHIND. A meeting being processed again — a
 * user retrying a failed transcription, an operator redriving a dead-lettered job — still holds
 * the transcript and the summary of the run before it, and asking `hasSummary` first would report
 * it as `ready` for the whole time the new run takes; the app would say the meeting was finished
 * while it was visibly being redone. So a `queued` or `running` job row decides the state before
 * the stored artifacts do, and before a failure an earlier attempt recorded.
 *
 * Failures win over everything except an open recording and a run in flight: ADR-001's promise is
 * that a failed stage never hides what succeeded, so the caller still receives the transcript and
 * the audio; the badge simply reports the failure.
 */
export function deriveMeetingState(input: MeetingStateInput): MeetingState {
  if (input.finalizedAt === null) {
    return { status: "recording", progress: null, failure: null };
  }

  if (input.transcribe?.status === "running") {
    return { status: "transcribing", progress: input.transcribe.progress, failure: null };
  }
  if (input.transcribe?.status === "queued") {
    return { status: "queued", progress: null, failure: null };
  }

  if (input.summarize?.status === "queued" || input.summarize?.status === "running") {
    return { status: "summarizing", progress: input.summarize.progress, failure: null };
  }

  const transcribeFailure = failureOf(input.transcribe, "transcribe");
  if (transcribeFailure) {
    return { status: "failed", progress: null, failure: transcribeFailure };
  }

  const summarizeFailure = failureOf(input.summarize, "summarize");
  if (summarizeFailure) {
    return { status: "failed", progress: null, failure: summarizeFailure };
  }

  if (input.hasSummary) {
    return { status: "ready", progress: null, failure: null };
  }

  // The gap before the summarize row exists. Its progress is covered by the branch above, which
  // is reached as soon as there is a row to read one from.
  if (input.hasTranscript) {
    return { status: "summarizing", progress: null, failure: null };
  }

  return { status: "queued", progress: null, failure: null };
}

function failureOf(stage: StageState | null, name: MeetingFailure["stage"]): MeetingFailure | null {
  if (stage?.status !== "failed") return null;
  return {
    stage: name,
    code: stage.error?.code ?? "UNKNOWN",
    // The pipeline always stores a message; the fallback only keeps the contract total.
    message: stage.error?.message ?? "The job failed without reporting a reason.",
  };
}
