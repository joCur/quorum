import { describe, expect, it } from "vitest";
import { runTranscribeJob } from "../src/handler.js";
import { audioDurationSeconds } from "../src/transcript/duration.js";
import {
  FakeAudioSource,
  FakeTranscriptionClient,
  InMemoryRepository,
  VERBOSE_RESPONSE_WITH_WORDS,
  capturingLogger,
  manifest,
  silentLogger,
  transcribePayload,
} from "./helpers.js";

/** A response of `seconds` of audio, with one segment that stops a little short of the end. */
function responseOf(seconds: number) {
  return {
    ...VERBOSE_RESPONSE_WITH_WORDS,
    duration: seconds,
    segments: [{ start: 0, end: Math.max(0, seconds - 2), text: " Something was said." }],
  };
}

describe("audioDurationSeconds", () => {
  it("believes the duration the backend reports", () => {
    expect(audioDurationSeconds(responseOf(1800))).toBe(1800);
  });

  it("falls back to the last segment when the backend reports no duration", () => {
    const { duration: _duration, ...withoutDuration } = responseOf(1800);
    expect(audioDurationSeconds(withoutDuration)).toBe(1798);
  });

  it("reports nothing rather than zero when there is neither", () => {
    expect(audioDurationSeconds({ text: "", duration: 0, segments: [] })).toBeNull();
  });
});

describe("the transcribe job's duration reconciliation", () => {
  it("stores the decoded length of the audio with the transcript", async () => {
    const repository = new InMemoryRepository();
    const outcome = await runTranscribeJob(transcribePayload(), 0, {
      audio: new FakeAudioSource(manifest({ recordedSeconds: 1795 })),
      transcription: new FakeTranscriptionClient("small", responseOf(1800)),
      repository,
      logger: silentLogger,
    });

    expect(repository.durations.get(outcome.transcriptId)).toBe(1800);
  });

  it("reports a recording whose assertion matches its audio as reconciled", async () => {
    const { logger, events } = capturingLogger();
    await runTranscribeJob(transcribePayload(), 0, {
      audio: new FakeAudioSource(manifest({ recordedSeconds: 1798 })),
      transcription: new FakeTranscriptionClient("small", responseOf(1800)),
      repository: new InMemoryRepository(),
      logger,
    });

    const reconciled = events.find((event) => event.event === "duration.reconciled");
    expect(reconciled).toMatchObject({ outcome: "within_tolerance", billableSeconds: 1800 });
    expect(events.some((event) => event.event === "duration.understated")).toBe(false);
  });

  it("flags a recording that asserted far less audio than it produced", async () => {
    const { logger, events } = capturingLogger();
    await runTranscribeJob(transcribePayload(), 0, {
      audio: new FakeAudioSource(manifest({ recordedSeconds: 600 })),
      transcription: new FakeTranscriptionClient("small", responseOf(3600)),
      repository: new InMemoryRepository(),
      logger,
    });

    expect(events.find((event) => event.event === "duration.understated")).toMatchObject({
      level: "warn",
      assertedSeconds: 600,
      trueSeconds: 3600,
      shortfallSeconds: 3000,
      billableSeconds: 3600,
    });
  });

  it("applies the tolerance the deployment configured", async () => {
    const { logger, events } = capturingLogger();
    await runTranscribeJob(transcribePayload(), 0, {
      audio: new FakeAudioSource(manifest({ recordedSeconds: 1795 })),
      transcription: new FakeTranscriptionClient("small", responseOf(1800)),
      repository: new InMemoryRepository(),
      logger,
      durationTolerance: { absoluteSeconds: 1, relative: 0 },
    });

    expect(events.some((event) => event.event === "duration.understated")).toBe(true);
  });

  it("flags nothing when the manifest carries no assertion", async () => {
    const { logger, events } = capturingLogger();
    await runTranscribeJob(transcribePayload(), 0, {
      audio: new FakeAudioSource(manifest({ recordedSeconds: null })),
      transcription: new FakeTranscriptionClient("small", responseOf(3600)),
      repository: new InMemoryRepository(),
      logger,
    });

    expect(events.find((event) => event.event === "duration.reconciled")).toMatchObject({
      outcome: "unknown",
    });
  });

  it("warns when a client asserted a duration but the audio produced none to check it against", async () => {
    // The quiet way past `duration.understated`: audio nothing measures, and a quota that then
    // has only the client's word to fall back on.
    const { logger, events } = capturingLogger();
    await runTranscribeJob(transcribePayload(), 0, {
      audio: new FakeAudioSource(manifest({ recordedSeconds: 30 })),
      transcription: new FakeTranscriptionClient("small", { text: "", segments: [] }),
      repository: new InMemoryRepository(),
      logger,
    });

    expect(events.find((event) => event.event === "duration.unmeasured")).toMatchObject({
      level: "warn",
      outcome: "unknown",
      assertedSeconds: 30,
      trueSeconds: null,
    });
  });

  it("stays quiet when neither side has a number to compare", async () => {
    const { logger, events } = capturingLogger();
    await runTranscribeJob(transcribePayload(), 0, {
      audio: new FakeAudioSource(manifest({ recordedSeconds: null })),
      transcription: new FakeTranscriptionClient("small", { text: "", segments: [] }),
      repository: new InMemoryRepository(),
      logger,
    });

    expect(events.some((event) => event.event === "duration.unmeasured")).toBe(false);
    expect(events.find((event) => event.event === "duration.reconciled")).toMatchObject({
      level: "info",
      outcome: "unknown",
    });
  });

  it("does not fail the job when the backend reports no duration at all", async () => {
    const repository = new InMemoryRepository();
    const outcome = await runTranscribeJob(transcribePayload(), 0, {
      audio: new FakeAudioSource(manifest({ recordedSeconds: 1795 })),
      transcription: new FakeTranscriptionClient("small", {
        text: "nothing timed",
        segments: [],
      }),
      repository,
      logger: silentLogger,
    });

    expect(outcome.created).toBe(true);
    expect(repository.durations.get(outcome.transcriptId)).toBeNull();
  });
});
