import { describe, expect, it } from "vitest";
import { JobError } from "../src/errors.js";
import { runTranscribeJob } from "../src/handler.js";
import { transcriptIdForJob } from "../src/ids.js";
import { parseTranscribeJobPayload } from "../src/payload.js";
import {
  FakeAudioSource,
  FakeTranscriptionClient,
  InMemoryRepository,
  JOB_ID,
  MEETING_ID,
  VERBOSE_RESPONSE_WITH_WORDS,
  capturingLogger,
  manifest,
  silentLogger,
  transcribeJob,
  transcribePayload,
} from "./helpers.js";
import { RecordingEnqueuer } from "./summary-helpers.js";
import { SYSTEM_SUMMARY_TEMPLATE } from "../src/summary/template.js";

function deps(overrides: Partial<Parameters<typeof runTranscribeJob>[2]> = {}) {
  return {
    audio: new FakeAudioSource(),
    transcription: new FakeTranscriptionClient(),
    repository: new InMemoryRepository(),
    logger: silentLogger,
    ...overrides,
  };
}

describe("transcribe job", () => {
  it("turns a finalized recording into a persisted transcript with word timestamps", async () => {
    const dependencies = deps();
    const outcome = await runTranscribeJob(transcribePayload(), 0, dependencies);

    expect(outcome.created).toBe(true);
    expect(outcome.segmentCount).toBe(2);
    expect(outcome.wordCount).toBe(6);
    expect(outcome.transcriptId).toBe(transcriptIdForJob(JOB_ID));

    const repository = dependencies.repository as InMemoryRepository;
    const stored = repository.transcripts.get(outcome.transcriptId)!;
    expect(stored.transcript.meetingId).toBe(MEETING_ID);
    expect(stored.scope.tenantId).toBe("tenant-a");
    expect(stored.transcript.segments[0]!.words).not.toBeNull();
  });

  it("sends the container the manifest announced to the transcription backend", async () => {
    const client = new FakeTranscriptionClient();
    await runTranscribeJob(transcribePayload(), 0, deps({ transcription: client }));
    expect(client.requests[0]).toMatchObject({
      filename: "recording.webm",
      contentType: "audio/webm",
    });
  });

  it("uses the session start as recordedAt, not the finalization time", async () => {
    const dependencies = deps();
    const outcome = await runTranscribeJob(transcribePayload(), 0, dependencies);
    const repository = dependencies.repository as InMemoryRepository;
    expect(repository.transcripts.get(outcome.transcriptId)!.transcript.recordedAt).toBe(
      "2026-08-29T10:00:00.000Z",
    );
  });

  it("falls back to the manifest finalization time when the session object is gone", async () => {
    const dependencies = deps({
      audio: new FakeAudioSource(manifest(), new Uint8Array([1, 2, 3]), null),
    });
    const outcome = await runTranscribeJob(transcribePayload(), 0, dependencies);
    const repository = dependencies.repository as InMemoryRepository;
    expect(repository.transcripts.get(outcome.transcriptId)!.transcript.recordedAt).toBe(
      "2026-08-29T10:30:00.000Z",
    );
  });

  it("records the job lifecycle from the shared job schema", async () => {
    const dependencies = deps();
    await runTranscribeJob(transcribePayload(), 0, dependencies);
    const states = (dependencies.repository as InMemoryRepository).jobStates;

    expect(states.map((state) => state.status)).toEqual(["running", "succeeded"]);
    expect(states[0]!.startedAt).not.toBeNull();
    expect(states[1]!.resultId).toBe(transcriptIdForJob(JOB_ID));
    expect(states[1]!.progress).toBe(1);
    expect(states[1]!.error).toBeNull();
  });
});

describe("idempotency", () => {
  it("does not create a second transcript when the same job runs again", async () => {
    const dependencies = deps();
    const first = await runTranscribeJob(transcribePayload(), 0, dependencies);
    const second = await runTranscribeJob(transcribePayload(), 1, dependencies);

    expect(second.transcriptId).toBe(first.transcriptId);
    expect(second.created).toBe(false);
    const repository = dependencies.repository as InMemoryRepository;
    expect(repository.transcripts.size).toBe(1);
    expect(repository.activeTranscripts).toHaveLength(1);
  });

  it("keeps exactly one active transcript when the meeting is transcribed again", async () => {
    const dependencies = deps();
    await runTranscribeJob(transcribePayload(), 0, dependencies);
    await runTranscribeJob(
      transcribePayload({ job: transcribeJob({ id: "44444444-4444-4444-8444-444444444444" }) }),
      0,
      dependencies,
    );

    const repository = dependencies.repository as InMemoryRepository;
    expect(repository.transcripts.size).toBe(2);
    expect(repository.activeTranscripts).toHaveLength(1);
  });
});

describe("failure handling", () => {
  it("records a failed job with the machine-readable code and rethrows", async () => {
    const dependencies = deps({
      transcription: new FakeTranscriptionClient(
        "small",
        VERBOSE_RESPONSE_WITH_WORDS,
        new JobError("TRANSCRIPTION_UNAVAILABLE", "backend is warming up", { retryable: true }),
      ),
    });

    await expect(runTranscribeJob(transcribePayload(), 0, dependencies)).rejects.toMatchObject({
      code: "TRANSCRIPTION_UNAVAILABLE",
      retryable: true,
    });

    const states = (dependencies.repository as InMemoryRepository).jobStates;
    expect(states.at(-1)).toMatchObject({
      status: "failed",
      error: { code: "TRANSCRIPTION_UNAVAILABLE", message: "backend is warming up" },
    });
  });

  it("treats an unexpected error as retryable and internal", async () => {
    const dependencies = deps({
      transcription: new FakeTranscriptionClient(
        "small",
        VERBOSE_RESPONSE_WITH_WORDS,
        new Error("kaboom"),
      ),
    });
    await expect(runTranscribeJob(transcribePayload(), 0, dependencies)).rejects.toMatchObject({
      code: "INTERNAL_ERROR",
      retryable: true,
    });
  });

  it("writes no transcript when the run fails", async () => {
    const dependencies = deps({
      transcription: new FakeTranscriptionClient(
        "small",
        VERBOSE_RESPONSE_WITH_WORDS,
        new Error("x"),
      ),
    });
    await expect(runTranscribeJob(transcribePayload(), 0, dependencies)).rejects.toThrow();
    expect((dependencies.repository as InMemoryRepository).transcripts.size).toBe(0);
  });
});

/**
 * A meeting can be deleted while its transcription is already running. The
 * cascade drops the work still queued for it, but an active job survives that
 * sweep, and persisting its transcript afterwards would bring a deleted
 * recording back (ADR-001). The handler checks the meeting immediately before
 * the write and abandons the job quietly.
 */
describe("a meeting deleted while the job runs", () => {
  it("persists normally while the meeting is still there", async () => {
    const dependencies = deps();
    const outcome = await runTranscribeJob(transcribePayload(), 0, dependencies);

    expect(outcome.abandoned).toBeUndefined();
    expect((dependencies.repository as InMemoryRepository).transcripts.size).toBe(1);
  });

  it("writes no transcript and no job row when the meeting is already gone", async () => {
    const repository = new InMemoryRepository();
    repository.meetings.delete(MEETING_ID);
    const { logger, events } = capturingLogger();

    const outcome = await runTranscribeJob(transcribePayload(), 0, deps({ repository, logger }));

    expect(outcome.abandoned).toBe("meeting-deleted");
    expect(repository.transcripts.size).toBe(0);
    expect(repository.jobStates).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      level: "info",
      event: "job.abandoned",
      reason: "meeting-deleted",
      artifact: "transcript",
      jobId: JOB_ID,
      meetingId: MEETING_ID,
      tenantId: "tenant-a",
    });
  });

  // The tightest window there is: the job has started and recorded itself as
  // running, the audio has been transcribed, and the delete commits in the
  // instant before the insert. The real repository closes this by checking and
  // inserting in one transaction; here the hook fires at the same point.
  it("writes nothing when the delete lands between the job start and the persist", async () => {
    const repository = new InMemoryRepository();
    repository.onBeforeSaveTranscript = () => repository.meetings.delete(MEETING_ID);
    const summaries = new RecordingEnqueuer();

    const outcome = await runTranscribeJob(
      transcribePayload(),
      0,
      deps({ repository, summaries, summaryTemplateId: SYSTEM_SUMMARY_TEMPLATE.id }),
    );

    expect(outcome.abandoned).toBe("meeting-deleted");
    expect(repository.transcripts.size).toBe(0);
    // The `running` row was written before the delete, and the cascade removes
    // it. What matters is that nothing was written *after* the meeting was gone.
    expect(repository.jobStates.map((state) => state.status)).toEqual(["running"]);
    // No follow-up summary job either — that would only resurrect the meeting
    // one queue hop later.
    expect(summaries.enqueued).toEqual([]);
    expect(outcome.summaryEnqueued).toBe(false);
  });

  it("resolves instead of throwing, so the queue completes rather than dead-letters", async () => {
    const repository = new InMemoryRepository();
    repository.meetings.delete(MEETING_ID);

    await expect(
      runTranscribeJob(transcribePayload(), 0, deps({ repository })),
    ).resolves.toMatchObject({ abandoned: "meeting-deleted" });
  });
});

describe("job payload validation", () => {
  it("accepts what the recording endpoint enqueues", () => {
    expect(parseTranscribeJobPayload(transcribePayload()).job.id).toBe(JOB_ID);
  });

  it("rejects a payload without the tenant scope", () => {
    expect(() => parseTranscribeJobPayload({ job: transcribeJob() })).toThrow(
      /unusable transcribe payload/,
    );
  });

  it("rejects a job of the wrong type", () => {
    const payload = { ...transcribePayload(), job: transcribeJob({ type: "summarize" }) };
    expect(() => parseTranscribeJobPayload(payload)).toThrow(
      /does not belong on the transcribe queue/,
    );
  });
});
