import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AudioFormat, Job, MeetingDetail, TranscriptionJobAccepted } from "@quorum/shared";
import { buildServer } from "../src/app.js";
import { createTokenVerifier } from "../src/auth/token-verifier.js";
import { DEFAULT_USER_LIMITS, StaticUserLimitsResolver } from "../src/limits.js";
import { InMemoryRecordingStorage } from "../src/recording/storage/memory.js";
import { InMemoryJobQueue } from "../src/recording/queue/memory.js";
import { InMemoryMeetingStore } from "../src/meetings/memory.js";
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
const GLOBEX_MEETING = uuid("b", 1);

const JOB_ID = uuid("9", 1);

function transcribeJob(meetingId: string, overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
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
const store = new InMemoryMeetingStore();

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
  store.setPipeline(GLOBEX_MEETING, { jobs: [transcribeJob(GLOBEX_MEETING)] });
}

beforeAll(async () => {
  await seed(RETRYABLE, ACME);
  await seed(TERMINAL, ACME);
  await seed(HEALTHY, ACME);
  await seed(BUSY, ACME);
  await seed(GLOBEX_MEETING, GLOBEX);

  queue = new InMemoryJobQueue();

  app = await buildServer({
    storage: new InMemoryRecordingStorage(),
    queue,
    meetings: store,
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

beforeEach(() => {
  seedPipelines();
  queue.enqueued.length = 0;
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
      id: JOB_ID,
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
        jobId: JOB_ID,
        meetingId: RETRYABLE,
        tenantId: ACME.tenantId,
        userId: ACME.userId,
        sessionId: RETRYABLE,
      },
    ]);
  });

  it("stops reporting the meeting as failed once the retry is accepted", async () => {
    expect((await detail(RETRYABLE, ACME)).meeting.status).toBe("failed");

    await retry(RETRYABLE, ACME);

    const after = await detail(RETRYABLE, ACME);
    expect(after.meeting.status).toBe("queued");
    expect(after.meeting.failure).toBeNull();
    expect(after.jobs[0]).toMatchObject({ id: JOB_ID, status: "queued", error: null });
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

  it("accepts only the first of two retries of the same job", async () => {
    const [first, second] = await Promise.all([retry(RETRYABLE, ACME), retry(RETRYABLE, ACME)]);
    const codes = [first.statusCode, second.statusCode].sort((a, b) => a - b);
    expect(codes).toEqual([202, 409]);
    // One accepted request, one transcription. This is the guard that makes a retry storm
    // impossible without relying on the rate limiter alone.
    expect(queue.enqueued).toHaveLength(1);
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

  it("puts the failure back when the job never reached the queue", async () => {
    queue.failNextEnqueue = true;
    const response = await retry(RETRYABLE, ACME);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "queue_unavailable" });

    // The meeting reports the failure it actually has, and the action is available again — the
    // one outcome a half-finished retry must not produce is a meeting waiting for a run nobody
    // started.
    const after = await detail(RETRYABLE, ACME);
    expect(after.meeting.status).toBe("failed");
    expect(after.meeting.failure).toMatchObject({ stage: "transcribe" });

    queue.failNextEnqueue = false;
    expect((await retry(RETRYABLE, ACME)).statusCode).toBe(202);
  });
});

describe("the retry allowance", () => {
  it("meters the route on the small allowance that guards pipeline work", async () => {
    const metered = await buildServer({
      storage: new InMemoryRecordingStorage(),
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
