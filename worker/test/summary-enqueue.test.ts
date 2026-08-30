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

/**
 * The first summary of a recording is made with the template its owner chose, without anybody
 * picking one before recording. The choice is resolved at enqueue time, because this is where the
 * recording's tenant and user are known; the resolved id then travels in the payload, so a
 * replayed summarize job cannot follow a preference that changed in the meantime.
 */
describe("the template the automatic summary is made with", () => {
  const OWN_TEMPLATE = "9a3f2c1d-4b5e-4a77-8c91-2d6e5f4a3b21";

  function withDefault(templateId: string): InMemoryRepository {
    const repository = new InMemoryRepository();
    repository.defaultTemplates.set("tenant-a user-1", templateId);
    return repository;
  }

  it("is the user's default when they have chosen one", async () => {
    const dependencies = deps({ repository: withDefault(OWN_TEMPLATE) });
    await runTranscribeJob(transcribePayload(), 0, dependencies);

    expect((dependencies.summaries as RecordingEnqueuer).enqueued[0]?.templateId).toBe(
      OWN_TEMPLATE,
    );
  });

  it("is the system template when they have chosen none", async () => {
    const dependencies = deps();
    await runTranscribeJob(transcribePayload(), 0, dependencies);

    expect((dependencies.summaries as RecordingEnqueuer).enqueued[0]?.templateId).toBe(
      SYSTEM_SUMMARY_TEMPLATE.id,
    );
  });

  it("belongs to the recording's own user, not to whoever else set one", async () => {
    const dependencies = deps({ repository: withDefault(OWN_TEMPLATE) });
    await runTranscribeJob(transcribePayload({ userId: "user-2" }), 0, dependencies);

    expect((dependencies.summaries as RecordingEnqueuer).enqueued[0]?.templateId).toBe(
      SYSTEM_SUMMARY_TEMPLATE.id,
    );
  });

  /**
   * The transcript is already committed when this runs, so a settings read that fails may cost
   * the shape of the summary but never the summary itself.
   */
  it("falls back to the system template when the setting cannot be read", async () => {
    const repository = new InMemoryRepository();
    repository.defaultTemplateLookupError = new Error("settings unavailable");
    const dependencies = deps({ repository });

    const outcome = await runTranscribeJob(transcribePayload(), 0, dependencies);

    expect(outcome.summaryEnqueued).toBe(true);
    expect((dependencies.summaries as RecordingEnqueuer).enqueued[0]?.templateId).toBe(
      SYSTEM_SUMMARY_TEMPLATE.id,
    );
  });

  it("names the chosen template in the job id, so it is its own summary", async () => {
    const dependencies = deps({ repository: withDefault(OWN_TEMPLATE) });
    await runTranscribeJob(transcribePayload(), 0, dependencies);
    const enqueued = (dependencies.summaries as RecordingEnqueuer).enqueued[0];

    expect(enqueued && summarizeJobPayload(enqueued).job.id).toBe(
      summarizeJobIdFor(transcriptIdForJob(JOB_ID), OWN_TEMPLATE),
    );
  });
});

/**
 * The resolution chain, most specific first: the template chosen for this meeting before
 * recording, then the user's default, then the system template. Each link is skipped when it
 * names a template the user cannot see, so the chain always ends somewhere usable.
 */
describe("the order the summary template is resolved in", () => {
  const CHOSEN = "1c9d8e7f-6a5b-4c3d-8e2f-1a0b9c8d7e6f";
  const PREFERRED = "9a3f2c1d-4b5e-4a77-8c91-2d6e5f4a3b21";

  /**
   * A run where the recorder chose `chosen` before starting and the user's default is
   * `preferred`. `visible` lists the templates that still exist when the summary is enqueued.
   */
  function scenario(options: {
    chosen?: string | null;
    preferred?: string | null;
    visible?: readonly string[];
  }) {
    const audio = new FakeAudioSource();
    audio.sessionTemplateId = options.chosen ?? null;

    const repository = new InMemoryRepository();
    if (options.preferred) repository.defaultTemplates.set("tenant-a user-1", options.preferred);
    for (const id of options.visible ?? []) repository.visibleTemplates.add(id);

    return deps({ audio, repository });
  }

  async function templateOf(
    dependencies: ReturnType<typeof scenario>,
  ): Promise<string | undefined> {
    await runTranscribeJob(transcribePayload(), 0, dependencies);
    return (dependencies.summaries as RecordingEnqueuer).enqueued[0]?.templateId;
  }

  it("prefers the meeting's own choice over the user's default", async () => {
    const dependencies = scenario({
      chosen: CHOSEN,
      preferred: PREFERRED,
      visible: [CHOSEN, PREFERRED],
    });
    expect(await templateOf(dependencies)).toBe(CHOSEN);
  });

  it("uses the user's default when this meeting carries no choice", async () => {
    const dependencies = scenario({ preferred: PREFERRED, visible: [PREFERRED] });
    expect(await templateOf(dependencies)).toBe(PREFERRED);
  });

  it("uses the system template when there is neither", async () => {
    const dependencies = scenario({});
    expect(await templateOf(dependencies)).toBe(SYSTEM_SUMMARY_TEMPLATE.id);
  });

  /**
   * A recording can outlive the template it was started with — the user may delete it while the
   * transcription is still running. That is a fall to the next link, not a failed summary.
   */
  it("falls through to the default when the chosen template is gone by then", async () => {
    const dependencies = scenario({ chosen: CHOSEN, preferred: PREFERRED, visible: [PREFERRED] });
    expect(await templateOf(dependencies)).toBe(PREFERRED);
  });

  it("falls all the way to the system template when the choice is stale and there is no default", async () => {
    const dependencies = scenario({ chosen: CHOSEN, visible: [] });
    expect(await templateOf(dependencies)).toBe(SYSTEM_SUMMARY_TEMPLATE.id);
  });

  /** ADR-001: an id that arrives from a client is a claim, and a claim on somebody else's data fails. */
  it("ignores a chosen template belonging to somebody else", async () => {
    const dependencies = scenario({ chosen: CHOSEN, preferred: PREFERRED, visible: [PREFERRED] });
    expect(await templateOf(dependencies)).toBe(PREFERRED);
  });

  it("still enqueues a summary when the templates cannot be read at all", async () => {
    const dependencies = scenario({ chosen: CHOSEN, visible: [CHOSEN] });
    (dependencies.repository as InMemoryRepository).defaultTemplateLookupError = new Error(
      "templates unavailable",
    );

    const outcome = await runTranscribeJob(transcribePayload(), 0, dependencies);

    expect(outcome.summaryEnqueued).toBe(true);
    expect((dependencies.summaries as RecordingEnqueuer).enqueued[0]?.templateId).toBe(
      SYSTEM_SUMMARY_TEMPLATE.id,
    );
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
