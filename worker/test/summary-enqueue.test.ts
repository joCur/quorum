import { describe, expect, it } from "vitest";
import { runTranscribeJob } from "../src/handler.js";
import { summarizeJobIdFor, transcriptIdForJob } from "../src/ids.js";
import { SUMMARIZE_QUEUE } from "../src/payload.js";
import { PgBossSummaryEnqueuer, summarizeJobPayload } from "../src/summary/enqueue.js";
import { SYSTEM_SUMMARY_TEMPLATE } from "../src/summary/template.js";
import {
  FakeAudioSource,
  FakeTranscriptionClient,
  InMemoryRepository,
  JOB_ID,
  MEETING_ID,
  silentLogger,
  transcribeJob,
  transcribePayload,
} from "./helpers.js";
import { RecordingEnqueuer } from "./summary-helpers.js";

function deps(overrides: Partial<Parameters<typeof runTranscribeJob>[2]> = {}) {
  return {
    audio: new FakeAudioSource(),
    transcription: new FakeTranscriptionClient(),
    repository: new InMemoryRepository(),
    logger: silentLogger,
    summaries: new RecordingEnqueuer(),
    summaryTemplateId: SYSTEM_SUMMARY_TEMPLATE.id,
    ...overrides,
  };
}

describe("enqueueing the summary when a transcript is persisted", () => {
  it("enqueues one summary job for the transcript it just wrote", async () => {
    const dependencies = deps();
    const outcome = await runTranscribeJob(transcribePayload(), 0, dependencies);
    const enqueuer = dependencies.summaries as RecordingEnqueuer;

    expect(outcome.summaryEnqueued).toBe(true);
    expect(enqueuer.enqueued).toHaveLength(1);
    expect(enqueuer.enqueued[0]).toMatchObject({
      transcriptId: transcriptIdForJob(JOB_ID),
      meetingId: MEETING_ID,
      templateId: SYSTEM_SUMMARY_TEMPLATE.id,
      tenantId: "tenant-a",
      userId: "user-1",
      sessionId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("addresses the transcript by id, not by 'whatever is active'", async () => {
    const dependencies = deps();
    await runTranscribeJob(transcribePayload(), 0, dependencies);
    await runTranscribeJob(
      transcribePayload({ job: transcribeJob({ id: "44444444-4444-4444-8444-444444444444" }) }),
      0,
      dependencies,
    );
    const enqueued = (dependencies.summaries as RecordingEnqueuer).enqueued;

    expect(enqueued.map((input) => input.transcriptId)).toEqual([
      transcriptIdForJob(JOB_ID),
      transcriptIdForJob("44444444-4444-4444-8444-444444444444"),
    ]);
  });

  it("derives a stable job id, so a replayed transcribe job cannot buy a second summary", async () => {
    const dependencies = deps();
    await runTranscribeJob(transcribePayload(), 0, dependencies);
    await runTranscribeJob(transcribePayload(), 1, dependencies);

    const ids = (dependencies.summaries as RecordingEnqueuer).enqueued.map(
      (input) => summarizeJobPayload(input).job.id,
    );
    expect(ids[0]).toBe(summarizeJobIdFor(transcriptIdForJob(JOB_ID), SYSTEM_SUMMARY_TEMPLATE.id));
    expect(new Set(ids).size).toBe(1);
  });

  it("still succeeds when the queue insert fails, rather than re-transcribing", async () => {
    const dependencies = deps({ summaries: new RecordingEnqueuer(new Error("queue is down")) });
    const outcome = await runTranscribeJob(transcribePayload(), 0, dependencies);

    expect(outcome.summaryEnqueued).toBe(false);
    expect(outcome.created).toBe(true);
    expect((dependencies.repository as InMemoryRepository).transcripts.size).toBe(1);
  });

  it("enqueues nothing when the run failed", async () => {
    const dependencies = deps({
      transcription: new FakeTranscriptionClient("small", undefined, new Error("kaboom")),
    });
    await expect(runTranscribeJob(transcribePayload(), 0, dependencies)).rejects.toThrow();
    expect((dependencies.summaries as RecordingEnqueuer).enqueued).toHaveLength(0);
  });

  it("stops at the transcript when no enqueuer is configured", async () => {
    const dependencies = deps({ summaries: undefined, summaryTemplateId: undefined });
    const outcome = await runTranscribeJob(transcribePayload(), 0, dependencies);
    expect(outcome.summaryEnqueued).toBe(false);
  });
});

describe("the payload put on the summary queue", () => {
  const input = {
    transcriptId: transcriptIdForJob(JOB_ID),
    meetingId: MEETING_ID,
    templateId: SYSTEM_SUMMARY_TEMPLATE.id,
    tenantId: "tenant-a",
    userId: "user-1",
    sessionId: "11111111-1111-4111-8111-111111111111",
    createdAt: "2026-08-29T11:00:00.000Z",
  };

  it("is a queued summarize job carrying the full scope", () => {
    expect(summarizeJobPayload(input)).toMatchObject({
      job: { type: "summarize", status: "queued", meetingId: MEETING_ID, resultId: null },
      tenantId: "tenant-a",
      userId: "user-1",
      transcriptId: input.transcriptId,
      templateId: SYSTEM_SUMMARY_TEMPLATE.id,
    });
  });

  it("uses the derived job id as the pg-boss singleton key", async () => {
    const sent: { queue: string; payload: unknown; options: unknown }[] = [];
    const boss = {
      async send(queue: string, payload: unknown, options: unknown) {
        sent.push({ queue, payload, options });
        return "queue-row-id";
      },
    };

    await new PgBossSummaryEnqueuer(boss as never).enqueue(input);

    expect(sent[0]!.queue).toBe(SUMMARIZE_QUEUE);
    expect(sent[0]!.options).toEqual({
      singletonKey: summarizeJobIdFor(input.transcriptId, SYSTEM_SUMMARY_TEMPLATE.id),
    });
  });
});
