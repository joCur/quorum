import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  SUMMARY_SCHEMA_VERSION,
  SummaryTemplateSchema,
  SYSTEM_TEMPLATE_ID,
  TRANSCRIPT_SCHEMA_VERSION,
  type AudioFormat,
  type Job,
  type SummaryJobAccepted,
  type SummaryTemplate,
  type SummaryTemplateView,
  type Transcript,
} from "@quorum/shared";
import { buildServer } from "../src/app.js";
import { createTokenVerifier } from "../src/auth/token-verifier.js";
import { DEFAULT_USER_LIMITS, StaticUserLimitsResolver } from "../src/limits.js";
import { InMemoryRecordingStorage } from "../src/recording/storage/memory.js";
import { InMemoryJobQueue } from "../src/recording/queue/memory.js";
import { InMemoryMeetingStore } from "../src/meetings/memory.js";
import { InMemorySummaryTemplateStore } from "../src/templates/memory.js";
import { AUDIENCE, INTERNAL_ISSUER, ISSUER, createTestKeyPair, signAccessToken } from "./keys.js";
import type { TestKeyPair } from "./keys.js";

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

/** Summarized already — the meeting a user would press "Regenerate" on. */
const SUMMARIZED = uuid("a", 1);
/** Finalized, but the transcript is not there yet. */
const NOT_TRANSCRIBED = uuid("a", 2);
/** A summary of this one is already on its way. */
const BUSY = uuid("a", 3);
const GLOBEX_MEETING = uuid("b", 1);
const TRANSCRIPT_ID = uuid("c", 1);

const SYSTEM_TEMPLATE: SummaryTemplate = SummaryTemplateSchema.parse({
  id: SYSTEM_TEMPLATE_ID,
  schemaVersion: SUMMARY_SCHEMA_VERSION,
  name: "Standard meeting summary",
  version: 1,
  scope: "system",
  basedOn: null,
  sections: [{ id: "overview", title: "Overview", instruction: "What happened.", format: "prose" }],
  overrides: [],
  options: {},
});

function transcriptFor(meetingId: string): Transcript {
  return {
    id: TRANSCRIPT_ID,
    meetingId,
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    isActive: true,
    model: "whisper",
    modelVersion: "large-v3",
    language: "de",
    recordedAt: "2026-08-29T10:00:00.000Z",
    createdAt: "2026-08-29T10:06:00.000Z",
    speakers: [],
    segments: [
      {
        id: uuid("d", 1),
        start: 0,
        end: 12.5,
        text: "Guten Morgen zusammen.",
        editedText: null,
        confidence: 0.9,
        speakerId: null,
        editedSpeakerId: null,
        language: null,
        words: null,
      },
    ],
  };
}

function job(meetingId: string, status: Job["status"], index: number): Job {
  return {
    id: uuid("9", index),
    meetingId,
    type: "summarize",
    status,
    progress: null,
    error: null,
    resultId: null,
    createdAt: "2026-08-29T10:05:30.000Z",
    startedAt: null,
    finishedAt: null,
  };
}

let app: FastifyInstance;
let queue: InMemoryJobQueue;
let templates: InMemorySummaryTemplateStore;
const store = new InMemoryMeetingStore();

async function token(scope: { tenantId: string; userId: string }): Promise<string> {
  return signAccessToken(keys, {
    subject: scope.userId,
    tenantId: scope.tenantId,
    roles: ["quorum-user"],
  });
}

async function regenerate(
  meetingId: string,
  scope: { tenantId: string; userId: string },
  payload: Record<string, unknown> = {},
) {
  return app.inject({
    method: "POST",
    url: `/api/meetings/${meetingId}/summaries`,
    headers: { authorization: `Bearer ${await token(scope)}` },
    payload,
  });
}

beforeAll(async () => {
  const seed = async (
    meetingId: string,
    scope: { tenantId: string; userId: string },
  ): Promise<void> => {
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
  };

  await seed(SUMMARIZED, ACME);
  await seed(NOT_TRANSCRIBED, ACME);
  await seed(BUSY, ACME);
  await seed(GLOBEX_MEETING, GLOBEX);

  store.setPipeline(SUMMARIZED, {
    transcript: transcriptFor(SUMMARIZED),
    jobs: [job(SUMMARIZED, "succeeded", 1)],
  });
  store.setPipeline(BUSY, {
    transcript: transcriptFor(BUSY),
    jobs: [job(BUSY, "running", 2)],
  });
  store.setPipeline(GLOBEX_MEETING, { transcript: transcriptFor(GLOBEX_MEETING) });

  queue = new InMemoryJobQueue();
  templates = new InMemorySummaryTemplateStore();
  templates.seedSystemTemplate(SYSTEM_TEMPLATE);

  app = await buildServer({
    storage: new InMemoryRecordingStorage(),
    queue,
    meetings: store,
    templates,
    auth: {
      verifyAccessToken: createTokenVerifier({
        issuers: [INTERNAL_ISSUER, ISSUER],
        audience: AUDIENCE,
        tenantClaim: "tenant_id",
        keySource: keys.jwks,
      }),
    },
    // These tests exercise the regenerate handler, not the rate limiter, and there are more cases
    // here than the production per-minute allowance for a route that costs a model call.
    limits: new StaticUserLimitsResolver({
      ...DEFAULT_USER_LIMITS,
      apiSummaryRequestsPerWindow: 1_000,
    }),
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("regenerating a summary", () => {
  it("requires an access token", async () => {
    const response = await app.inject({
      method: "POST",
      url: `/api/meetings/${SUMMARIZED}/summaries`,
      payload: {},
    });
    expect(response.statusCode).toBe(401);
  });

  it("enqueues a summarize job for the active transcript and the system template", async () => {
    queue.summarized.length = 0;
    const response = await regenerate(SUMMARIZED, ACME);
    expect(response.statusCode).toBe(202);

    const accepted = response.json() as SummaryJobAccepted;
    expect(accepted.job.type).toBe("summarize");
    expect(accepted.job.status).toBe("queued");
    expect(accepted.job.meetingId).toBe(SUMMARIZED);
    expect(accepted.templateId).toBe(SYSTEM_TEMPLATE_ID);
    expect(accepted.transcriptId).toBe(TRANSCRIPT_ID);

    expect(queue.summarized).toHaveLength(1);
    expect(queue.summarized[0]).toMatchObject({
      jobId: accepted.job.id,
      meetingId: SUMMARIZED,
      tenantId: ACME.tenantId,
      userId: ACME.userId,
      sessionId: SUMMARIZED,
      transcriptId: TRANSCRIPT_ID,
      templateId: SYSTEM_TEMPLATE_ID,
    });
  });

  it("mints a fresh job id per request, so a second run is not swallowed as a replay", async () => {
    queue.summarized.length = 0;
    const first = (await regenerate(SUMMARIZED, ACME)).json() as SummaryJobAccepted;
    const second = (await regenerate(SUMMARIZED, ACME)).json() as SummaryJobAccepted;
    expect(first.job.id).not.toBe(second.job.id);
  });

  it("uses a user template when one is named", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/summary-templates",
      headers: { authorization: `Bearer ${await token(ACME)}` },
      payload: { name: "My layout", overrides: [] },
    });
    const templateId = (created.json() as SummaryTemplateView).template.id;

    queue.summarized.length = 0;
    const response = await regenerate(SUMMARIZED, ACME, { templateId });
    expect(response.statusCode).toBe(202);
    expect(queue.summarized[0]).toMatchObject({ templateId });
  });

  it("refuses a template belonging to somebody else with 404", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/summary-templates",
      headers: { authorization: `Bearer ${await token(GLOBEX)}` },
      payload: { name: "Theirs", overrides: [] },
    });
    const templateId = (created.json() as SummaryTemplateView).template.id;

    const response = await regenerate(SUMMARIZED, ACME, { templateId });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "template_not_found" });
  });

  it("answers a meeting of another tenant with 404, never 403", async () => {
    const response = await regenerate(GLOBEX_MEETING, ACME);
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "meeting_not_found" });
  });

  it("answers a malformed meeting id with 404", async () => {
    const response = await regenerate("not-a-uuid", ACME);
    expect(response.statusCode).toBe(404);
  });

  it("refuses a meeting that has no transcript yet", async () => {
    const response = await regenerate(NOT_TRANSCRIBED, ACME);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "transcript_not_available" });
  });

  it("refuses a transcript id that is not the meeting's active one", async () => {
    const response = await regenerate(SUMMARIZED, ACME, { transcriptId: uuid("f", 7) });
    expect(response.statusCode).toBe(409);
  });

  it("refuses a second run while a summary of the same meeting is still being written", async () => {
    const response = await regenerate(BUSY, ACME);
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: "summary_in_progress" });
  });

  it("writes no job row of its own — the worker owns that state", async () => {
    await regenerate(SUMMARIZED, ACME);
    const detail = await app.inject({
      method: "GET",
      url: `/api/meetings/${SUMMARIZED}`,
      headers: { authorization: `Bearer ${await token(ACME)}` },
    });
    const { jobs } = detail.json() as { jobs: Job[] };
    expect(jobs.filter((entry) => entry.status === "queued")).toHaveLength(0);
  });
});
