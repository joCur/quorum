import { describe, expect, it } from "vitest";
import {
  deriveMeetingState,
  IN_FLIGHT_MAX_AGE_MS,
  type MeetingStateInput,
  type StageState,
} from "../src/meetings/status.js";

/** The moment every case is evaluated at, so "recent" and "stale" are exact. */
const NOW = new Date("2026-08-29T12:00:00.000Z");

function state(overrides: Partial<MeetingStateInput> = {}): MeetingStateInput {
  return {
    finalizedAt: "2026-08-29T10:05:00.000Z",
    transcribe: null,
    summarize: null,
    hasTranscript: false,
    hasSummary: false,
    now: NOW,
    ...overrides,
  };
}

/** A job row the pipeline wrote a moment ago, unless the case says otherwise. */
function stage(overrides: Partial<StageState> & Pick<StageState, "status">): StageState {
  return {
    progress: null,
    error: null,
    updatedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    ...overrides,
  };
}

describe("meeting status derivation", () => {
  it("reports an unfinalized session as recording", () => {
    expect(deriveMeetingState(state({ finalizedAt: null })).status).toBe("recording");
  });

  it("reports a finalized recording without a job row as queued", () => {
    // The transcription worker writes the job row when it picks the job up, so between
    // `session.end` and that moment no row exists. The absence is the queue wait.
    expect(deriveMeetingState(state()).status).toBe("queued");
  });

  it("keeps reporting queued while the job row says queued", () => {
    const derived = deriveMeetingState(
      state({ transcribe: stage({ status: "queued", progress: null, error: null }) }),
    );
    expect(derived.status).toBe("queued");
  });

  it("reports a running transcription with its progress", () => {
    const derived = deriveMeetingState(
      state({ transcribe: stage({ status: "running", progress: 0.4, error: null }) }),
    );
    expect(derived).toMatchObject({ status: "transcribing", progress: 0.4 });
  });

  it("reports a stored transcript without a summarize row as summarizing", () => {
    // The summarize job is enqueued by the worker after the transcript is stored, so the row
    // appears later still. Reporting the gap as summarizing keeps the badge truthful without
    // writing a placeholder job row from the enqueuing side.
    const derived = deriveMeetingState(state({ hasTranscript: true }));
    expect(derived).toMatchObject({ status: "summarizing", progress: null });
  });

  it("carries the summary progress once the summarize job runs", () => {
    const derived = deriveMeetingState(
      state({
        hasTranscript: true,
        summarize: stage({ status: "running", progress: 0.75, error: null }),
      }),
    );
    expect(derived).toMatchObject({ status: "summarizing", progress: 0.75 });
  });

  it("reports ready once a summary is stored", () => {
    const derived = deriveMeetingState(state({ hasTranscript: true, hasSummary: true }));
    expect(derived).toMatchObject({ status: "ready", failure: null });
  });

  it("surfaces a failed transcription with its code and message", () => {
    const derived = deriveMeetingState(
      state({
        transcribe: stage({
          status: "failed",
          progress: null,
          error: { code: "AUDIO_DECODE_FAILED", message: "The audio could not be decoded." },
        }),
      }),
    );
    expect(derived).toEqual({
      status: "failed",
      progress: null,
      failure: {
        stage: "transcribe",
        code: "AUDIO_DECODE_FAILED",
        message: "The audio could not be decoded.",
      },
    });
  });

  it("surfaces a failed summary even though the transcript succeeded", () => {
    const derived = deriveMeetingState(
      state({
        hasTranscript: true,
        transcribe: stage({ status: "succeeded", progress: null, error: null }),
        summarize: stage({
          status: "failed",
          progress: null,
          error: { code: "LLM_UNAVAILABLE", message: "The summary model did not respond." },
        }),
      }),
    );
    expect(derived.status).toBe("failed");
    expect(derived.failure).toMatchObject({ stage: "summarize", code: "LLM_UNAVAILABLE" });
  });

  it("reports a re-queued transcription even though the meeting is already summarized", () => {
    // A retry, or an operator redrive on a finished meeting. Asking `hasSummary` first would call
    // this `ready` for the whole run and leave the reprocessing invisible in the app.
    const derived = deriveMeetingState(
      state({
        hasTranscript: true,
        hasSummary: true,
        transcribe: stage({ status: "queued", progress: null, error: null }),
        summarize: stage({ status: "succeeded", progress: null, error: null }),
      }),
    );
    expect(derived).toMatchObject({ status: "queued", failure: null });
  });

  it("reports a re-run transcription of a summarized meeting as transcribing", () => {
    const derived = deriveMeetingState(
      state({
        hasTranscript: true,
        hasSummary: true,
        transcribe: stage({ status: "running", progress: 0.2, error: null }),
        summarize: stage({ status: "succeeded", progress: null, error: null }),
      }),
    );
    expect(derived).toMatchObject({ status: "transcribing", progress: 0.2 });
  });

  it("reports a re-run summary of a summarized meeting as summarizing", () => {
    const derived = deriveMeetingState(
      state({
        hasTranscript: true,
        hasSummary: true,
        transcribe: stage({ status: "succeeded", progress: null, error: null }),
        summarize: stage({ status: "queued", progress: null, error: null }),
      }),
    );
    expect(derived).toMatchObject({ status: "summarizing", failure: null });
  });

  it("stops reporting a failure the moment the job is handed back to the queue", () => {
    // What the retry endpoint writes: the same row, moved from `failed` to `queued`. The screen
    // has to stop offering an action the user has already taken.
    const derived = deriveMeetingState(
      state({ transcribe: stage({ status: "queued", progress: null, error: null }) }),
    );
    expect(derived).toEqual({ status: "queued", progress: null, failure: null });
  });

  it("lets a transcription in flight outrank a summary that failed earlier", () => {
    const derived = deriveMeetingState(
      state({
        hasTranscript: true,
        transcribe: stage({ status: "running", progress: null, error: null }),
        summarize: stage({
          status: "failed",
          progress: null,
          error: { code: "SUMMARY_UNAVAILABLE", message: "the model did not answer" },
        }),
      }),
    );
    expect(derived).toMatchObject({ status: "transcribing", failure: null });
  });

  it("stops believing a running row that has gone quiet for longer than any attempt", () => {
    // A worker killed mid-job leaves `running` behind for good: the row is not a heartbeat, and
    // the attempt that would have settled it is gone. Letting it outrank a stored summary for
    // ever would tell a finished meeting it is still being worked on.
    const derived = deriveMeetingState(
      state({
        hasTranscript: true,
        hasSummary: true,
        summarize: stage({
          status: "running",
          updatedAt: new Date(NOW.getTime() - IN_FLIGHT_MAX_AGE_MS - 1_000).toISOString(),
        }),
      }),
    );
    expect(derived).toMatchObject({ status: "ready", failure: null });
  });

  it("believes a running row that was written inside the window", () => {
    const derived = deriveMeetingState(
      state({
        hasTranscript: true,
        hasSummary: true,
        summarize: stage({
          status: "running",
          updatedAt: new Date(NOW.getTime() - IN_FLIGHT_MAX_AGE_MS + 60_000).toISOString(),
        }),
      }),
    );
    expect(derived).toMatchObject({ status: "summarizing" });
  });

  it("believes a row whose store cannot say when it was written", () => {
    const derived = deriveMeetingState(
      state({ transcribe: stage({ status: "running", progress: 0.5, updatedAt: null }) }),
    );
    expect(derived).toMatchObject({ status: "transcribing", progress: 0.5 });
  });

  it("does not report a failure while the recording is still open", () => {
    const derived = deriveMeetingState(
      state({
        finalizedAt: null,
        transcribe: stage({ status: "failed", progress: null, error: { code: "X", message: "y" } }),
      }),
    );
    expect(derived.status).toBe("recording");
  });

  it("keeps the failure contract total when a job failed without an error payload", () => {
    const derived = deriveMeetingState(
      state({ transcribe: stage({ status: "failed", progress: null, error: null }) }),
    );
    expect(derived.failure).toMatchObject({ stage: "transcribe", code: "UNKNOWN" });
    expect(derived.failure?.message).not.toBe("");
  });
});
