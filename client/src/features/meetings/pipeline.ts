import type { MeetingDetail } from "@quorum/shared";

/**
 * The processing pipeline as the user sees it (STATES.md §4).
 *
 * `uploading` is the client's own business — it covers the stretch before the recording is
 * finalized, which the server reports simply as an open recording.
 */
export const PIPELINE_STAGES = ["uploading", "queued", "transcribing", "summarizing"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

export type StepState = "done" | "active" | "failed" | "upcoming";

export interface PipelineStep {
  stage: PipelineStage;
  state: StepState;
  /** 0..1 when the worker reports numbers. Never invented — no fake progress. */
  progress: number | null;
}

/**
 * Turns a meeting into the stepper's four steps.
 *
 * The meeting status is the single input for which stage is current, because it is already the
 * server's derived answer to that question; the job rows only contribute the progress number and
 * the identity of a failed stage. Deriving the stage a second time from the jobs would give the
 * badge and the stepper two chances to disagree.
 */
export function pipelineSteps(detail: MeetingDetail): PipelineStep[] {
  const { meeting } = detail;
  const failedStage = meeting.failure?.stage ?? null;
  const currentIndex = stageIndexFor(meeting);

  return PIPELINE_STAGES.map((stage, index) => {
    if (failedStage !== null && stageOfJobType(failedStage) === stage) {
      return { stage, state: "failed", progress: null };
    }
    if (meeting.status === "ready" || index < currentIndex) {
      return { stage, state: "done", progress: null };
    }
    if (index === currentIndex) {
      return { stage, state: "active", progress: meeting.progress };
    }
    return { stage, state: "upcoming", progress: null };
  });
}

/** True once the whole pipeline has finished — the stepper then has nothing left to report. */
export function isPipelineComplete(detail: MeetingDetail): boolean {
  return detail.meeting.status === "ready";
}

function stageIndexFor(meeting: MeetingDetail["meeting"]): number {
  switch (meeting.status) {
    case "recording":
      return 0;
    case "queued":
      return 1;
    case "transcribing":
      return 2;
    case "summarizing":
      return 3;
    case "ready":
      return PIPELINE_STAGES.length;
    case "failed":
      // Every stage before the failed one succeeded; the failed one is marked separately.
      return meeting.failure?.stage === "summarize" ? 3 : 2;
  }
}

function stageOfJobType(
  type: NonNullable<MeetingDetail["meeting"]["failure"]>["stage"],
): PipelineStage {
  return type === "transcribe" ? "transcribing" : "summarizing";
}
