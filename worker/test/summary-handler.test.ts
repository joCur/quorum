import { describe, expect, it } from "vitest";
import { SummaryTemplateSchema, type SummaryTemplate } from "@quorum/shared";
import { JobError } from "../src/errors.js";
import { runSummarizeJob } from "../src/summary/handler.js";
import { summarizeJobIdFor, summaryIdForJob } from "../src/ids.js";
import { parseSummarizeJobPayload } from "../src/payload.js";
import { SYSTEM_SUMMARY_TEMPLATE } from "../src/summary/template.js";
import { summarizeJobPayload } from "../src/summary/enqueue.js";
import { MEETING_ID, capturingLogger, silentLogger, transcribeJob } from "./helpers.js";
import {
  FakeChatClient,
  InMemorySummaryRepository,
  SUMMARIZE_JOB_ID,
  TRANSCRIPT_ID,
  WELL_FORMED_ANSWER,
  summarizeJob,
  summarizePayload,
  transcriptFixture,
} from "./summary-helpers.js";

function deps(overrides: Partial<Parameters<typeof runSummarizeJob>[2]> = {}) {
  return {
    chat: new FakeChatClient(),
    repository: new InMemorySummaryRepository(),
    logger: silentLogger,
    maxInputTokens: 14_000,
    ...overrides,
  };
}

describe("summarize job", () => {
  it("turns a transcript into a persisted, structured summary", async () => {
    const dependencies = deps();
    const outcome = await runSummarizeJob(summarizePayload(), 0, dependencies);

    expect(outcome.created).toBe(true);
    expect(outcome.repaired).toBe(false);
    expect(outcome.sectionCount).toBe(5);
    expect(outcome.summaryId).toBe(summaryIdForJob(SUMMARIZE_JOB_ID));

    const repository = dependencies.repository as InMemorySummaryRepository;
    const stored = repository.summaries.get(outcome.summaryId)!;
    expect(stored.summary.meetingId).toBe(MEETING_ID);
    expect(stored.summary.transcriptId).toBe(TRANSCRIPT_ID);
    expect(stored.summary.sections[2]!.content).toEqual([
      "Ship on the fifteenth, because the migration is done.",
    ]);
  });

  it("carries the tenant and user scope into the stored row (ADR-001)", async () => {
    const dependencies = deps();
    const outcome = await runSummarizeJob(summarizePayload(), 0, dependencies);
    const stored = (dependencies.repository as InMemorySummaryRepository).summaries.get(
      outcome.summaryId,
    )!;
    expect(stored.scope).toEqual({
      tenantId: "tenant-a",
      userId: "user-1",
      sessionId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("persists the template snapshot with the summary", async () => {
    const dependencies = deps();
    const outcome = await runSummarizeJob(summarizePayload(), 0, dependencies);
    const summary = (dependencies.repository as InMemorySummaryRepository).summaries.get(
      outcome.summaryId,
    )!.summary;

    expect(summary.templateSnapshot.templateId).toBe(SYSTEM_SUMMARY_TEMPLATE.id);
    expect(summary.templateSnapshot.resolvedSections).toHaveLength(5);
    expect(summary.templateSnapshot.options).toEqual({
      ...SYSTEM_SUMMARY_TEMPLATE.options,
      // `auto` is resolved against the transcript before it is snapshotted, so the
      // summary can always say which language it was asked for.
      outputLanguage: "en",
    });
  });

  describe("output language", () => {
    it("follows the transcript when the template says `auto`", async () => {
      const dependencies = deps({
        repository: new InMemorySummaryRepository([transcriptFixture({ language: "de" })]),
      });
      const outcome = await runSummarizeJob(summarizePayload(), 0, dependencies);
      const repository = dependencies.repository as InMemorySummaryRepository;

      expect(
        repository.summaries.get(outcome.summaryId)!.summary.templateSnapshot.options,
      ).toMatchObject({ outputLanguage: "de" });
      const prompt = (dependencies.chat as FakeChatClient).calls[0]![1]!.content;
      expect(prompt).toContain("Write the summary in de");
    });

    it("keeps an explicitly chosen language even when the transcript differs", async () => {
      const template = SummaryTemplateSchema.parse({
        ...SYSTEM_SUMMARY_TEMPLATE,
        options: { ...SYSTEM_SUMMARY_TEMPLATE.options, outputLanguage: "fr" },
      });
      const dependencies = deps({
        repository: new InMemorySummaryRepository(
          [transcriptFixture({ language: "de" })],
          [template],
        ),
      });
      const outcome = await runSummarizeJob(summarizePayload(), 0, dependencies);
      const repository = dependencies.repository as InMemorySummaryRepository;

      expect(
        repository.summaries.get(outcome.summaryId)!.summary.templateSnapshot.options,
      ).toMatchObject({ outputLanguage: "fr" });
    });

    it("stays on `auto` when the transcript could not name a language", async () => {
      const dependencies = deps({
        repository: new InMemorySummaryRepository([transcriptFixture({ language: "auto" })]),
      });
      const outcome = await runSummarizeJob(summarizePayload(), 0, dependencies);
      const repository = dependencies.repository as InMemorySummaryRepository;

      expect(
        repository.summaries.get(outcome.summaryId)!.summary.templateSnapshot.options,
      ).toMatchObject({ outputLanguage: "auto" });
    });
  });

  describe("user templates", () => {
    const USER_TEMPLATE_ID = "7c3f0e21-1a55-4d0a-9f2b-6e8c1d4a9b33";

    /** A user template with no sections of its own — everything is an override on the base. */
    function userTemplate(overrides: SummaryTemplate["overrides"]): SummaryTemplate {
      return SummaryTemplateSchema.parse({
        ...SYSTEM_SUMMARY_TEMPLATE,
        id: USER_TEMPLATE_ID,
        name: "My layout",
        scope: "user",
        sections: [],
        basedOn: SYSTEM_SUMMARY_TEMPLATE.id,
        overrides,
      });
    }

    it("snapshots the sections inherited from the base plus its own overrides", async () => {
      const dependencies = deps({
        repository: new InMemorySummaryRepository(
          [transcriptFixture()],
          [
            SYSTEM_SUMMARY_TEMPLATE,
            userTemplate([{ sectionId: "key-points", action: "hide", section: null }]),
          ],
        ),
      });
      const outcome = await runSummarizeJob(
        summarizePayload({ templateId: USER_TEMPLATE_ID }),
        0,
        dependencies,
      );
      const repository = dependencies.repository as InMemorySummaryRepository;
      const snapshot = repository.summaries.get(outcome.summaryId)!.summary.templateSnapshot;

      expect(snapshot.templateId).toBe(USER_TEMPLATE_ID);
      expect(snapshot.resolvedSections.map((section) => section.id)).toEqual([
        "overview",
        "decisions",
        "action-items",
        "open-questions",
      ]);
    });

    it("fails terminally when the base template it inherits from is gone", async () => {
      const dependencies = deps({
        repository: new InMemorySummaryRepository([transcriptFixture()], [userTemplate([])]),
      });
      await expect(
        runSummarizeJob(summarizePayload({ templateId: USER_TEMPLATE_ID }), 0, dependencies),
      ).rejects.toMatchObject({ code: "SUMMARY_TEMPLATE_NOT_FOUND", retryable: false });
    });
  });

  it("prefers the model the backend reports over the configured name", async () => {
    const dependencies = deps({
      chat: new FakeChatClient([WELL_FORMED_ANSWER], "router/auto", "vendor/real-model-v2"),
    });
    const outcome = await runSummarizeJob(summarizePayload(), 0, dependencies);
    const summary = (dependencies.repository as InMemorySummaryRepository).summaries.get(
      outcome.summaryId,
    )!.summary;
    expect(summary.model).toBe("vendor/real-model-v2");
  });

  it("records the job lifecycle from the shared job schema", async () => {
    const dependencies = deps();
    await runSummarizeJob(summarizePayload(), 0, dependencies);
    const states = (dependencies.repository as InMemorySummaryRepository).jobStates;

    expect(states.map((state) => state.status)).toEqual(["running", "succeeded"]);
    expect(states[1]!.resultId).toBe(summaryIdForJob(SUMMARIZE_JOB_ID));
    expect(states[1]!.progress).toBe(1);
    expect(states[1]!.error).toBeNull();
  });
});

describe("malformed model output", () => {
  it("repairs an unparseable first answer with exactly one follow-up call", async () => {
    const chat = new FakeChatClient(["Here you go, boss!", WELL_FORMED_ANSWER]);
    const dependencies = deps({ chat });
    const outcome = await runSummarizeJob(summarizePayload(), 0, dependencies);

    expect(outcome.repaired).toBe(true);
    expect(outcome.created).toBe(true);
    expect(chat.calls).toHaveLength(2);
    // The repair turn replays the conversation plus the complaint.
    expect(chat.calls[1]!.length).toBe(chat.calls[0]!.length + 2);
  });

  it("fails terminally when the repair attempt is unparseable too", async () => {
    const chat = new FakeChatClient(["nope", "still nope"]);
    const dependencies = deps({ chat });

    await expect(runSummarizeJob(summarizePayload(), 0, dependencies)).rejects.toMatchObject({
      code: "SUMMARY_RESPONSE_INVALID",
      retryable: false,
    });
    // Two calls, never three: a third would just cost money.
    expect(chat.calls).toHaveLength(2);
    expect((dependencies.repository as InMemorySummaryRepository).summaries.size).toBe(0);
  });

  it("does not spend a repair call on an answer that merely skips sections", async () => {
    const chat = new FakeChatClient([
      JSON.stringify({ sections: [{ sectionId: "overview", content: ["It happened."] }] }),
    ]);
    const dependencies = deps({ chat });
    const outcome = await runSummarizeJob(summarizePayload(), 0, dependencies);

    expect(chat.calls).toHaveLength(1);
    expect(outcome.repaired).toBe(false);
    const summary = (dependencies.repository as InMemorySummaryRepository).summaries.get(
      outcome.summaryId,
    )!.summary;
    expect(summary.sections).toHaveLength(5);
    expect(summary.sections[1]!.content).toEqual([]);
  });
});

describe("idempotency", () => {
  it("does not create a second summary when the same job runs again", async () => {
    const dependencies = deps();
    const first = await runSummarizeJob(summarizePayload(), 0, dependencies);
    const second = await runSummarizeJob(summarizePayload(), 1, dependencies);

    expect(second.summaryId).toBe(first.summaryId);
    expect(second.created).toBe(false);
    const repository = dependencies.repository as InMemorySummaryRepository;
    expect(repository.summaries.size).toBe(1);
    expect(repository.activeSummaries).toHaveLength(1);
  });

  /**
   * The replay has to be free, not merely harmless.
   *
   * A transcribe job that runs again over a transcript it already produced enqueues the very same
   * summarize id, and the queue deduplicates nothing — so this path is walked in the ordinary
   * course of a retry. `saveSummary` has always recognized the replay, but only after the model
   * has answered and the tokens are spent; the point is not to call it at all.
   */
  it("calls no model when the job has already produced its summary", async () => {
    const dependencies = deps();
    const first = await runSummarizeJob(summarizePayload(), 0, dependencies);
    const chat = dependencies.chat as FakeChatClient;
    const callsAfterFirst = chat.calls.length;

    const replay = await runSummarizeJob(summarizePayload(), 1, dependencies);

    expect(replay).toMatchObject({ summaryId: first.summaryId, created: false });
    expect(chat.calls).toHaveLength(callsAfterFirst);
    // And the job still reports itself finished, pointing at the summary that exists.
    const repository = dependencies.repository as InMemorySummaryRepository;
    expect(repository.jobStates.at(-1)).toMatchObject({
      status: "succeeded",
      resultId: first.summaryId,
    });
  });

  it("keeps one active summary per template when the meeting is summarized again", async () => {
    const dependencies = deps();
    await runSummarizeJob(summarizePayload(), 0, dependencies);
    await runSummarizeJob(
      summarizePayload({ job: summarizeJob({ id: "77777777-7777-4777-8777-777777777777" }) }),
      0,
      dependencies,
    );

    const repository = dependencies.repository as InMemorySummaryRepository;
    expect(repository.summaries.size).toBe(2);
    expect(repository.activeSummaries).toHaveLength(1);
  });

  it("derives the same summarize job id for the same transcript and template", () => {
    const id = summarizeJobIdFor(TRANSCRIPT_ID, SYSTEM_SUMMARY_TEMPLATE.id);
    expect(summarizeJobIdFor(TRANSCRIPT_ID, SYSTEM_SUMMARY_TEMPLATE.id)).toBe(id);
    expect(summarizeJobIdFor(TRANSCRIPT_ID, "0b7a1f4d-2c3e-4a55-9f61-000000000000")).not.toBe(id);
  });
});

describe("failure handling", () => {
  it("is terminal when the transcript is gone", async () => {
    const dependencies = deps({ repository: new InMemorySummaryRepository([]) });
    await expect(runSummarizeJob(summarizePayload(), 0, dependencies)).rejects.toMatchObject({
      code: "TRANSCRIPT_NOT_FOUND",
      retryable: false,
    });
  });

  it("is terminal when the template is not available to the tenant", async () => {
    const dependencies = deps({
      repository: new InMemorySummaryRepository([transcriptFixture()], []),
    });
    await expect(runSummarizeJob(summarizePayload(), 0, dependencies)).rejects.toMatchObject({
      code: "SUMMARY_TEMPLATE_NOT_FOUND",
      retryable: false,
    });
  });

  it("is terminal when the transcript has no text in it", async () => {
    const empty = transcriptFixture({
      segments: transcriptFixture().segments.map((segment) => ({ ...segment, text: "  " })),
    });
    const dependencies = deps({ repository: new InMemorySummaryRepository([empty]) });
    await expect(runSummarizeJob(summarizePayload(), 0, dependencies)).rejects.toMatchObject({
      code: "TRANSCRIPT_EMPTY",
      retryable: false,
    });
  });

  it("keeps a backend outage retryable and records it on the job row", async () => {
    const dependencies = deps({
      chat: new FakeChatClient([
        new JobError("SUMMARY_UNAVAILABLE", "router is rate limiting", { retryable: true }),
      ]),
    });

    await expect(runSummarizeJob(summarizePayload(), 0, dependencies)).rejects.toMatchObject({
      code: "SUMMARY_UNAVAILABLE",
      retryable: true,
    });
    const states = (dependencies.repository as InMemorySummaryRepository).jobStates;
    expect(states.at(-1)).toMatchObject({
      status: "failed",
      error: { code: "SUMMARY_UNAVAILABLE", message: "router is rate limiting" },
    });
  });

  it("writes no summary when the run fails", async () => {
    const dependencies = deps({ chat: new FakeChatClient([new Error("kaboom")]) });
    await expect(runSummarizeJob(summarizePayload(), 0, dependencies)).rejects.toThrow();
    expect((dependencies.repository as InMemorySummaryRepository).summaries.size).toBe(0);
  });
});

/**
 * The same window as the transcription half, one queue hop later: the summarize
 * job is already running when the meeting is deleted. Its transcript vanishes
 * in the same cascade, so the handler has to tell "the meeting is gone" apart
 * from "this job is broken" — the first is a quiet no-op, the second still
 * dead-letters.
 */
describe("a meeting deleted while the job runs", () => {
  it("persists normally while the meeting is still there", async () => {
    const dependencies = deps();
    const outcome = await runSummarizeJob(summarizePayload(), 0, dependencies);

    expect(outcome.abandoned).toBeUndefined();
    expect((dependencies.repository as InMemorySummaryRepository).summaries.size).toBe(1);
  });

  it("writes no summary and no job row when the meeting is already gone", async () => {
    const repository = new InMemorySummaryRepository();
    repository.meetings.delete(MEETING_ID);
    repository.transcripts.clear(); // the cascade took the transcript too
    const { logger, events } = capturingLogger();

    const outcome = await runSummarizeJob(summarizePayload(), 0, deps({ repository, logger }));

    expect(outcome.abandoned).toBe("meeting-deleted");
    expect(repository.summaries.size).toBe(0);
    expect(repository.jobStates).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      level: "info",
      event: "job.abandoned",
      reason: "meeting-deleted",
      artifact: "summary",
      jobId: SUMMARIZE_JOB_ID,
      meetingId: MEETING_ID,
      tenantId: "tenant-a",
    });
  });

  // The tightest window: the model has already answered — the call is paid for
  // — and the delete commits in the instant before the insert. The real
  // repository checks and inserts in one transaction; the hook fires there.
  it("writes nothing when the delete lands between the job start and the persist", async () => {
    const repository = new InMemorySummaryRepository();
    repository.onBeforeSaveSummary = () => repository.meetings.delete(MEETING_ID);

    const outcome = await runSummarizeJob(summarizePayload(), 0, deps({ repository }));

    expect(outcome.abandoned).toBe("meeting-deleted");
    expect(repository.summaries.size).toBe(0);
    // The `running` row predates the delete and the cascade removes it; nothing
    // was written after the meeting was gone.
    expect(repository.jobStates.map((state) => state.status)).toEqual(["running"]);
  });

  it("resolves instead of throwing, so the queue completes rather than dead-letters", async () => {
    const repository = new InMemorySummaryRepository();
    repository.meetings.delete(MEETING_ID);
    repository.transcripts.clear();

    await expect(
      runSummarizeJob(summarizePayload(), 0, deps({ repository })),
    ).resolves.toMatchObject({ abandoned: "meeting-deleted" });
  });

  // The distinction that keeps the quiet path from swallowing real faults.
  it("still dead-letters a missing transcript when the meeting does exist", async () => {
    const repository = new InMemorySummaryRepository([]);

    await expect(
      runSummarizeJob(summarizePayload(), 0, deps({ repository })),
    ).rejects.toMatchObject({ code: "TRANSCRIPT_NOT_FOUND", retryable: false });
    expect(repository.jobStates.at(-1)).toMatchObject({ status: "failed" });
  });
});

describe("summarize payload validation", () => {
  it("accepts what the transcribe handler enqueues", () => {
    const payload = summarizeJobPayload({
      transcriptId: TRANSCRIPT_ID,
      meetingId: MEETING_ID,
      templateId: SYSTEM_SUMMARY_TEMPLATE.id,
      tenantId: "tenant-a",
      userId: "user-1",
      sessionId: "11111111-1111-4111-8111-111111111111",
      createdAt: "2026-08-29T11:00:00.000Z",
    });
    expect(parseSummarizeJobPayload(payload).transcriptId).toBe(TRANSCRIPT_ID);
  });

  it("rejects a payload without a transcript to summarize", () => {
    const { transcriptId: _transcriptId, ...rest } = summarizePayload();
    expect(() => parseSummarizeJobPayload(rest)).toThrow(/unusable summarize payload/);
  });

  it("rejects a transcribe job that landed on the summary queue", () => {
    const payload = { ...summarizePayload(), job: transcribeJob() };
    expect(() => parseSummarizeJobPayload(payload)).toThrow(
      /does not belong on the summarize queue/,
    );
  });
});
