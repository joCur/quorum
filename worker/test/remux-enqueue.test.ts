import { describe, expect, it } from "vitest";
import { runTranscribeJob } from "../src/handler.js";
import { remuxJobIdFor } from "../src/ids.js";
import { REMUX_QUEUE } from "../src/payload.js";
import {
  PgBossRemuxEnqueuer,
  remuxJobPayload,
  type EnqueueRemuxInput,
  type RemuxEnqueuer,
} from "../src/remux/enqueue.js";
import { SYSTEM_SUMMARY_TEMPLATE } from "../src/summary/template.js";
import {
  FakeAudioSource,
  FakeTranscriptionClient,
  InMemoryRepository,
  MEETING_ID,
  SCOPE,
  silentLogger,
  transcribeJob,
  transcribePayload,
} from "./helpers.js";
import { RecordingEnqueuer } from "./summary-helpers.js";

class RecordingRemuxEnqueuer implements RemuxEnqueuer {
  readonly enqueued: EnqueueRemuxInput[] = [];
  failure: Error | null = null;

  async enqueue(input: EnqueueRemuxInput): Promise<void> {
    if (this.failure) throw this.failure;
    this.enqueued.push(input);
  }
}

function deps(overrides: Partial<Parameters<typeof runTranscribeJob>[2]> = {}) {
  return {
    audio: new FakeAudioSource(),
    transcription: new FakeTranscriptionClient(),
    repository: new InMemoryRepository(),
    logger: silentLogger,
    summaries: new RecordingEnqueuer(),
    summaryTemplateId: SYSTEM_SUMMARY_TEMPLATE.id,
    remux: new RecordingRemuxEnqueuer(),
    ...overrides,
  };
}

describe("handing a finished recording on to be repackaged", () => {
  it("queues the repackaging when the transcription succeeded", async () => {
    const dependencies = deps();
    const outcome = await runTranscribeJob(transcribePayload(), 0, dependencies);
    const enqueuer = dependencies.remux as RecordingRemuxEnqueuer;

    expect(outcome.remuxEnqueued).toBe(true);
    expect(enqueuer.enqueued).toHaveLength(1);
    expect(enqueuer.enqueued[0]).toMatchObject({
      meetingId: MEETING_ID,
      tenantId: SCOPE.tenantId,
      userId: SCOPE.userId,
      sessionId: SCOPE.sessionId,
    });
  });

  it("passes the duration the transcription measured, as the check on the remuxer's own", () => {
    // The fake backend reports 4.2 s; that number is the independent account the remux job
    // compares its parse against before it deletes anything.
    const dependencies = deps();
    return runTranscribeJob(transcribePayload(), 0, dependencies).then(() => {
      const enqueuer = dependencies.remux as RecordingRemuxEnqueuer;
      expect(enqueuer.enqueued[0]?.expectedDurationSeconds).toBe(4.2);
    });
  });

  it("does not queue anything when the meeting was deleted mid-run", async () => {
    const repository = new InMemoryRepository();
    repository.meetings.clear();
    const dependencies = deps({ repository });

    const outcome = await runTranscribeJob(transcribePayload(), 0, dependencies);

    expect(outcome.abandoned).toBe("meeting-deleted");
    expect(outcome.remuxEnqueued).toBe(false);
    expect((dependencies.remux as RecordingRemuxEnqueuer).enqueued).toEqual([]);
  });

  it("does not fail the transcription when the queue insert fails", async () => {
    // The transcript is committed by this point. Failing here would buy a second full
    // transcription to fix a queue insert, and the thing that did not get queued is
    // housekeeping the user never asked for.
    const remux = new RecordingRemuxEnqueuer();
    remux.failure = new Error("queue is down");
    const outcome = await runTranscribeJob(transcribePayload(), 0, deps({ remux }));

    expect(outcome.remuxEnqueued).toBe(false);
    expect(outcome.transcriptId).toBeTruthy();
  });

  it("leaves the recording alone when no enqueuer is wired up at all", async () => {
    const outcome = await runTranscribeJob(transcribePayload(), 0, deps({ remux: undefined }));
    expect(outcome.remuxEnqueued).toBe(false);
  });
});

describe("the remux job payload", () => {
  const input: EnqueueRemuxInput = {
    meetingId: MEETING_ID,
    tenantId: SCOPE.tenantId,
    userId: SCOPE.userId,
    sessionId: SCOPE.sessionId,
    expectedDurationSeconds: 12.5,
    createdAt: "2026-08-29T10:31:00.000Z",
  };

  it("derives its id from the session, so a session cannot queue two of them", () => {
    expect(remuxJobPayload(input).job.id).toBe(remuxJobIdFor(SCOPE.sessionId));
    expect(remuxJobPayload({ ...input, createdAt: "2026-09-01T00:00:00.000Z" }).job.id).toBe(
      remuxJobPayload(input).job.id,
    );
  });

  it("carries the scope the job needs to find the audio", () => {
    expect(remuxJobPayload(input)).toMatchObject({
      tenantId: SCOPE.tenantId,
      userId: SCOPE.userId,
      sessionId: SCOPE.sessionId,
      expectedDurationSeconds: 12.5,
    });
  });

  it("sends the derived id as the singleton key, so a retry cannot double it", async () => {
    const sent: Array<{ queue: string; options: unknown }> = [];
    const boss = {
      send: async (queue: string, _payload: unknown, options: unknown) => {
        sent.push({ queue, options });
        return null;
      },
    };
    await new PgBossRemuxEnqueuer(boss as never).enqueue(input);

    expect(sent).toEqual([
      { queue: REMUX_QUEUE, options: { singletonKey: remuxJobIdFor(SCOPE.sessionId) } },
    ]);
  });
});

describe("a transcription that runs a second time", () => {
  it("asks for the same repackaging rather than a second one", async () => {
    // The user's retry path, and an operator's redrive: the ids have to collapse, or the queue
    // fills up with jobs whose whole content is discovering there is nothing to do.
    const dependencies = deps();
    await runTranscribeJob(transcribePayload(), 0, dependencies);
    await runTranscribeJob(
      transcribePayload({ job: transcribeJob({ id: "44444444-4444-4444-8444-444444444444" }) }),
      1,
      dependencies,
    );
    const enqueued = (dependencies.remux as RecordingRemuxEnqueuer).enqueued;

    expect(enqueued).toHaveLength(2);
    expect(remuxJobPayload(enqueued[0] as EnqueueRemuxInput).job.id).toBe(
      remuxJobPayload(enqueued[1] as EnqueueRemuxInput).job.id,
    );
  });
});
