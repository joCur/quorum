import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AudioFormat, Job, MeetingDetail, TranscriptionJobAccepted } from "@quorum/shared";
import { buildServer } from "../src/app.js";
import { createTokenVerifier } from "../src/auth/token-verifier.js";
import { DEFAULT_USER_LIMITS, StaticUserLimitsResolver } from "../src/limits.js";
import { InMemoryRecordingStorage } from "../src/recording/storage/memory.js";
import { InMemoryJobQueue } from "../src/recording/queue/memory.js";
import { InMemoryMeetingStore } from "../src/meetings/memory.js";
import { InMemoryUserSettingsStore } from "../src/settings/repository.js";
import { AUDIENCE, INTERNAL_ISSUER, ISSUER, createTestKeyPair, signAccessToken } from "./keys.js";
import type { TestKeyPair } from "./keys.js";

/**
 * Running a failed transcription again, from the client.
 *
 * The assertions are about the three things the endpoint promises: it replays the job the user's
 * own meeting failed on and no other, it refuses failures that repeating cannot undo, and the
 * meeting stops reporting a failure the moment the retry is accepted — the last one being what
 * the screen reads to stop offering the action.
 */

const keys: TestKeyPair = await createTestKeyPair();

const ACME = { tenantId: "tenant-acme", userId: "user-1" };
const GLOBEX = { tenantId: "tenant-globex", userId: "user-9" };

const WEBM_OPUS: AudioFormat = {
  codec: "opus",
  container: "webm",
  sampleRate: 48_000,
  channels: 1,
};

function uuid(tag: string, index: number): string {
  return `${tag.repeat(8).slice(0, 8)}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

/** The transcription failed for a reason another attempt could survive. */
const RETRYABLE = uuid("a", 1);
/** The transcription failed on the audio itself — nothing to try again. */
const TERMINAL = uuid("a", 2);
/** Transcribed and summarized; nothing failed. */
const HEALTHY = uuid("a", 3);
/** A transcription is already on its way. */
const BUSY = uuid("a", 4);
/**
 * The trap. Its row says `failed`, because the worker writes that on every attempt — including
 * the ones pg-boss is still going to repeat on its own — so the row alone cannot be trusted.
 */
const BACKING_OFF = uuid("a", 5);
/** A `queued` row with nothing behind it: a crash between the row move and the enqueue. */
const STRANDED = uuid("a", 6);
/** No session object was ever written for it, so its chosen language is unknowable. */
const NO_SESSION = uuid("a", 7);
const GLOBEX_MEETING = uuid("b", 1);

/**
 * One job id per meeting, differing from the meeting's own id in a single group.
 *
 * The retry keeps the job's id, so the queue is asked about that id — one shared id across the
 * fixtures would make every meeting look busy the moment any of them was.
 */
function jobIdFor(meetingId: string): string {
  return `${meetingId.slice(0, 8)}-0000-4000-9000-${meetingId.slice(-12)}`;
}

function transcribeJob(meetingId: string, overrides: Partial<Job> = {}): Job {
  return {
    id: jobIdFor(meetingId),
    meetingId,
    type: "transcribe",
    status: "failed",
    progress: null,
    error: { code: "TRANSCRIPTION_UNAVAILABLE", message: "backend answered 503" },
    resultId: null,
    createdAt: "2026-08-29T10:05:30.000Z",
    startedAt: "2026-08-29T10:05:40.000Z",
    finishedAt: "2026-08-29T10:06:00.000Z",
    ...overrides,
  };
}

let app: FastifyInstance;
let queue: InMemoryJobQueue;
let storage: InMemoryRecordingStorage;
let settings: InMemoryUserSettingsStore;
const store = new InMemoryMeetingStore();

/**
 * The session object the recording endpoint wrote at `session.start`.
 *
 * It is the only place that still knows which language this meeting was asked to be transcribed
 * in, which is why the retry reads it rather than the user's current default.
 */
async function seedSession(meetingId: string, language: string | null): Promise<void> {
  await storage.putSession({
    sessionId: meetingId,
    meetingId,
    tenantId: ACME.tenantId,
    userId: ACME.userId,
    meetingTitle: "Weekly sync",
    summaryTemplateId: null,
    language,
    audioFormat: WEBM_OPUS,
    createdAt: "2026-08-29T10:00:00.000Z",
    marks: [],
    recordedSeconds: 120,
  });
}

async function token(scope: { tenantId: string; userId: string }): Promise<string> {
  return signAccessToken(keys, {
    subject: scope.userId,
    tenantId: scope.tenantId,
    roles: ["quorum-user"],
  });
}

async function retry(meetingId: string, scope: { tenantId: string; userId: string }) {
  return app.inject({
    method: "POST",
    url: `/api/meetings/${meetingId}/transcription/retry`,
    headers: { authorization: `Bearer ${await token(scope)}` },
  });
}

async function detail(
  meetingId: string,
  scope: { tenantId: string; userId: string },
): Promise<MeetingDetail> {
  const response = await app.inject({
    method: "GET",
    url: `/api/meetings/${meetingId}`,
    headers: { authorization: `Bearer ${await token(scope)}` },
  });
  return response.json() as MeetingDetail;
}

async function seed(meetingId: string, scope: { tenantId: string; userId: string }): Promise<void> {
  await store.recordSession({
    meetingId,
    sessionId: meetingId,
    tenantId: scope.tenantId,
    userId: scope.userId,
    title: "Weekly sync",
    audioFormat: WEBM_OPUS,
    createdAt: "2026-08-29T10:00:00.000Z",
  });
  await store.markFinalized(scope, meetingId, "2026-08-29T10:05:00.000Z");
}

/** Rebuilt before every case, because an accepted retry mutates the job row it acted on. */
function seedPipelines(): void {
  store.setPipeline(RETRYABLE, { jobs: [transcribeJob(RETRYABLE)] });
  store.setPipeline(TERMINAL, {
    jobs: [
      transcribeJob(TERMINAL, {
        error: { code: "AUDIO_DECODE_FAILED", message: "the backend refused these bytes" },
      }),
    ],
  });
  store.setPipeline(HEALTHY, {
    jobs: [transcribeJob(HEALTHY, { status: "succeeded", error: null })],
  });
  store.setPipeline(BUSY, { jobs: [transcribeJob(BUSY, { status: "running", error: null })] });
  store.setPipeline(BACKING_OFF, { jobs: [transcribeJob(BACKING_OFF)] });
  store.setPipeline(STRANDED, {
    jobs: [transcribeJob(STRANDED, { status: "queued", error: null })],
  });
  store.setPipeline(NO_SESSION, { jobs: [transcribeJob(NO_SESSION)] });
  store.setPipeline(GLOBEX_MEETING, { jobs: [transcribeJob(GLOBEX_MEETING)] });
  // What the queue is holding. The running job and the one pg-boss is still going to repeat by
  // itself both have a live entry; the stranded row is the crash that left one behind without.
  store.setLiveQueueEntries([jobIdFor(BUSY), jobIdFor(BACKING_OFF)]);
}

beforeAll(async () => {
  await seed(RETRYABLE, ACME);
  await seed(TERMINAL, ACME);
  await seed(HEALTHY, ACME);
  await seed(BUSY, ACME);
  await seed(BACKING_OFF, ACME);
  await seed(STRANDED, ACME);
  await seed(NO_SESSION, ACME);
  await seed(GLOBEX_MEETING, GLOBEX);

  queue = new InMemoryJobQueue();
  storage = new InMemoryRecordingStorage();
  settings = new InMemoryUserSettingsStore();

  app = await buildServer({
    storage,
    queue,
    meetings: store,
    settings,
    auth: {
      verifyAccessToken: createTokenVerifier({
        issuers: [INTERNAL_ISSUER, ISSUER],
        audience: AUDIENCE,
        tenantClaim: "tenant_id",
        keySource: keys.jwks,
      }),
    },
    // These cases exercise the retry handler, not the limiter, and there are more of them than
    // the production per-minute allowance for a route that buys pipeline work.
    limits: new StaticUserLimitsResolver({
      ...DEFAULT_USER_LIMITS,
      apiSummaryRequestsPerWindow: 1_000,
    }),
  });
  await app.ready();
});

beforeEach(async () => {
  seedPipelines();
  queue.enqueued.length = 0;
  // Both halves of the language chain start empty, so a case that cares about one of them says
  // so rather than inheriting it from whichever case ran before.
  await settings.updateSettings(ACME, { transcriptionLanguage: null });
  await seedSession(RETRYABLE, null);
});

afterAll(async () => {
  await app.close();
});

describe("retrying a failed transcription", () => {
  it("requires an access token", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${RETRYABLE}/transcription/retry`,
    });
    expect(response.statusCode).toBe(401);
  });

  it("re-enqueues the job that failed, under the caller's own scope", async () => {
    const response = await retry(RETRYABLE, ACME);
    expect(response.statusCode).toBe(202);

    const accepted = response.json() as TranscriptionJobAccepted;
    expect(accepted.job).toMatchObject({
      id: jobIdFor(RETRYABLE),
      meetingId: RETRYABLE,
      type: "transcribe",
      status: "queued",
      error: null,
      startedAt: null,
      finishedAt: null,
    });

    // The same job id, not a new one: the transcript id is derived from it, so a replay overwrites
    // nothing and cannot produce a second transcript.
    expect(queue.enqueued).toEqual([
      {
        jobId: jobIdFor(RETRYABLE),
        meetingId: RETRYABLE,
        tenantId: ACME.tenantId,
        userId: ACME.userId,
        sessionId: RETRYABLE,
        language: null,
        vocabulary: [],
      },
    ]);
  });

  it("stops reporting the meeting as failed once the retry is accepted", async () => {
    expect((await detail(RETRYABLE, ACME)).meeting.status).toBe("failed");

    await retry(RETRYABLE, ACME);

    const after = await detail(RETRYABLE, ACME);
    expect(after.meeting.status).toBe("queued");
    expect(after.meeting.failure).toBeNull();
    expect(after.jobs[0]).toMatchObject({
      id: jobIdFor(RETRYABLE),
      status: "queued",
      error: null,
    });
  });

  it("refuses a failure another attempt cannot undo", async () => {
    const response = await retry(TERMINAL, ACME);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "transcription_not_retryable" });
    expect(queue.enqueued).toHaveLength(0);
    // And the meeting still says what it said, rather than pretending work has started.
    expect((await detail(TERMINAL, ACME)).meeting.status).toBe("failed");
  });

  it("refuses a meeting whose transcription did not fail", async () => {
    const response = await retry(HEALTHY, ACME);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "transcription_not_failed" });
    expect(queue.enqueued).toHaveLength(0);
  });

  it("refuses while a transcription is already running", async () => {
    const response = await retry(BUSY, ACME);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "transcription_in_progress" });
    expect(queue.enqueued).toHaveLength(0);
  });

  /**
   * The defect the row alone cannot see.
   *
   * A retryable failure writes `failed` into the job row on every attempt, including the ones
   * pg-boss is about to repeat by itself after its backoff — and `singletonKey` deduplicates
   * nothing under the `standard` policy both queues run on. A guard that trusted the row would
   * therefore put a second live entry on the queue during the backoff of the first: two
   * transcriptions of one recording, and a late failing attempt able to undo a finished one.
   */
  it("refuses while the queue is still going to repeat the failed job by itself", async () => {
    const response = await retry(BACKING_OFF, ACME);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "transcription_in_progress" });
    expect(queue.enqueued).toHaveLength(0);
    // And the row is untouched, so the automatic retry still finds the state it left.
    expect((await detail(BACKING_OFF, ACME)).jobs[0]).toMatchObject({ status: "failed" });
  });

  /**
   * The opposite question, answered by the same check.
   *
   * A crash between the row move and the enqueue would leave a `queued` row with nothing behind
   * it — a meeting waiting for ever on a run nobody started, which no user and no operator can
   * tell from a slow queue. Asking the queue rather than the row makes that state recoverable by
   * pressing the same button again.
   */
  it("hands back a queued row that no queue entry stands behind", async () => {
    const response = await retry(STRANDED, ACME);
    expect(response.statusCode).toBe(202);
    expect(queue.enqueued).toEqual([expect.objectContaining({ jobId: jobIdFor(STRANDED) })]);
  });

  it("accepts only the first of two retries of the same job", async () => {
    const [first, second] = await Promise.all([retry(RETRYABLE, ACME), retry(RETRYABLE, ACME)]);
    const codes = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(codes).toEqual([202, 409]);
    // One accepted request, one transcription. The queue entry the first one made is what the
    // second one runs into — the same thing that stops a retry storm without the rate limiter.
    expect(queue.enqueued).toHaveLength(1);
  });

  it("refuses a second retry once the first has put the job on the queue", async () => {
    expect((await retry(RETRYABLE, ACME)).statusCode).toBe(202);
    const again = await retry(RETRYABLE, ACME);
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ error: "transcription_in_progress" });
    expect(queue.enqueued).toHaveLength(1);
  });

  /**
   * The language is a property of the recording, not of the user's settings today.
   *
   * A retry an hour — or a month — later must transcribe what was asked for when the meeting was
   * recorded. Re-deriving it from the current default would quietly retranscribe a German meeting
   * in whatever the user has switched to since, which is precisely why the language travels in
   * the payload in the first place.
   */
  it("keeps the language the recording was made with", async () => {
    await seedSession(RETRYABLE, "de");
    await settings.updateSettings(ACME, { transcriptionLanguage: "fr" });

    expect((await retry(RETRYABLE, ACME)).statusCode).toBe(202);
    expect(queue.enqueued[0]).toMatchObject({ language: "de" });
  });

  it("falls back to the user's default when the recording named no language", async () => {
    await settings.updateSettings(ACME, { transcriptionLanguage: "fr" });

    expect((await retry(RETRYABLE, ACME)).statusCode).toBe(202);
    expect(queue.enqueued[0]).toMatchObject({ language: "fr" });
  });

  it("leaves the rest of the chain to the worker when nobody stated anything", async () => {
    expect((await retry(RETRYABLE, ACME)).statusCode).toBe(202);
    expect(queue.enqueued[0]).toMatchObject({ language: null });
  });

  it("retries without a language rather than not at all when the session is gone", async () => {
    // No session object was ever written for this meeting, so the recording's own choice is
    // unknowable. A transcript in the wrong language is worth more than a recording nobody can
    // recover, so the chain simply carries on with one link fewer.
    expect((await retry(NO_SESSION, ACME)).statusCode).toBe(202);
    expect(queue.enqueued[0]).toMatchObject({ language: null });
  });

  it("hides another tenant's meeting behind a 404 rather than a refusal", async () => {
    const response = await retry(GLOBEX_MEETING, ACME);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "meeting_not_found" });
    expect(queue.enqueued).toHaveLength(0);
  });

  it("answers a malformed meeting id the way a missing one is answered", async () => {
    const response = await retry("not-a-uuid", ACME);
    expect(response.statusCode).toBe(404);
  });

  it("leaves the failure standing when the job never reached the queue", async () => {
    queue.failNextEnqueue = true;
    const response = await retry(RETRYABLE, ACME);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "queue_unavailable" });

    // The row move and the enqueue are one step, so a failed enqueue takes the move with it. The
    // meeting reports the failure it actually has and the action is available again — the one
    // outcome a half-finished retry must not produce is a meeting waiting for a run nobody
    // started.
    const after = await detail(RETRYABLE, ACME);
    expect(after.meeting.status).toBe("failed");
    expect(after.meeting.failure).toMatchObject({ stage: "transcribe" });
    expect(after.jobs[0]).toMatchObject({
      status: "failed",
      error: { code: "TRANSCRIPTION_UNAVAILABLE" },
    });

    queue.failNextEnqueue = false;
    expect((await retry(RETRYABLE, ACME)).statusCode).toBe(202);
  });
});

describe("the retry allowance", () => {
  it("meters the route on the small allowance that guards pipeline work", async () => {
    const metered = await buildServer({
      storage,
      queue: new InMemoryJobQueue(),
      meetings: store,
      auth: {
        verifyAccessToken: createTokenVerifier({
          issuers: [INTERNAL_ISSUER, ISSUER],
          audience: AUDIENCE,
          tenantClaim: "tenant_id",
          keySource: keys.jwks,
        }),
      },
      limits: new StaticUserLimitsResolver({
        ...DEFAULT_USER_LIMITS,
        apiSummaryRequestsPerWindow: 1,
      }),
    });
    await metered.ready();

    try {
      const authorization = `Bearer ${await token(ACME)}`;
      const call = async () =>
        metered.inject({
          method: "POST",
          url: `/api/meetings/${TERMINAL}/transcription/retry`,
          headers: { authorization },
        });

      // The first request is answered on its merits — a refusal here, which still spends the
      // allowance — and the second one never reaches the handler.
      expect((await call()).statusCode).toBe(409);
      const second = await call();
      expect(second.statusCode).toBe(429);
      expect(second.json()).toMatchObject({ error: "limit.request_rate_exceeded" });
    } finally {
      await metered.close();
    }
  });
});
