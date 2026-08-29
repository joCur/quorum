import { describe, expect, it } from "vitest";
import { deriveMeetingState, type MeetingStateInput } from "../src/meetings/status.js";

function state(overrides: Partial<MeetingStateInput> = {}): MeetingStateInput {
  return {
    finalizedAt: "2026-08-29T10:05:00.000Z",
    transcribe: null,
    summarize: null,
    hasTranscript: false,
    hasSummary: false,
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
      state({ transcribe: { status: "queued", progress: null, error: null } }),
    );
    expect(derived.status).toBe("queued");
  });

  it("reports a running transcription with its progress", () => {
    const derived = deriveMeetingState(
      state({ transcribe: { status: "running", progress: 0.4, error: null } }),
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
        summarize: { status: "running", progress: 0.75, error: null },
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
        transcribe: {
          status: "failed",
          progress: null,
          error: { code: "AUDIO_DECODE_FAILED", message: "The audio could not be decoded." },
        },
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
        transcribe: { status: "succeeded", progress: null, error: null },
        summarize: {
          status: "failed",
          progress: null,
          error: { code: "LLM_UNAVAILABLE", message: "The summary model did not respond." },
        },
      }),
    );
    expect(derived.status).toBe("failed");
    expect(derived.failure).toMatchObject({ stage: "summarize", code: "LLM_UNAVAILABLE" });
  });

  it("does not report a failure while the recording is still open", () => {
    const derived = deriveMeetingState(
      state({
        finalizedAt: null,
        transcribe: { status: "failed", progress: null, error: { code: "X", message: "y" } },
      }),
    );
    expect(derived.status).toBe("recording");
  });

  it("keeps the failure contract total when a job failed without an error payload", () => {
    const derived = deriveMeetingState(
      state({ transcribe: { status: "failed", progress: null, error: null } }),
    );
    expect(derived.failure).toMatchObject({ stage: "transcribe", code: "UNKNOWN" });
    expect(derived.failure?.message).not.toBe("");
  });
});
