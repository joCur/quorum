import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import {
  SUMMARY_SCHEMA_VERSION,
  TRANSCRIPT_SCHEMA_VERSION,
  type AudioFormat,
  type Job,
  type Summary,
  type Transcript,
} from "@quorum/shared";
import { buildServer } from "../src/app.js";
import { createTokenVerifier } from "../src/auth/token-verifier.js";
import { InMemoryRecordingStorage } from "../src/recording/storage/memory.js";
import { InMemoryJobQueue } from "../src/recording/queue/memory.js";
import { InMemoryMeetingStore } from "../src/meetings/memory.js";
import { AUDIENCE, INTERNAL_ISSUER, ISSUER, createTestKeyPair, signAccessToken } from "./keys.js";
import type { TestKeyPair } from "./keys.js";

const keys: TestKeyPair = await createTestKeyPair();

const WEBM_OPUS: AudioFormat = {
  codec: "opus",
  container: "webm",
  sampleRate: 48_000,
  channels: 1,
};

/** Readable, deterministic UUIDs — the tenth meeting is `...-000000000010`. */
function uuid(tag: string, index: number): string {
  return `${tag.repeat(8).slice(0, 8)}-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

const ACME = { tenantId: "tenant-acme", userId: "user-1" };
const GLOBEX = { tenantId: "tenant-globex", userId: "user-9" };

const ACME_WEEKLY = uuid("a", 1);
const ACME_RETRO = uuid("a", 2);
const ACME_OPEN = uuid("a", 3);
const GLOBEX_BOARD = uuid("b", 1);
const ACME_OTHER_USER = uuid("a", 4);

let app: FastifyInstance;
const store = new InMemoryMeetingStore();

function transcriptFor(meetingId: string): Transcript {
  return {
    id: uuid("c", 1),
    meetingId,
    schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
    isActive: true,
    model: "whisper",
    modelVersion: "large-v3",
    language: "en",
    recordedAt: "2026-08-29T10:00:00.000Z",
    createdAt: "2026-08-29T10:06:00.000Z",
    speakers: [],
    segments: [
      {
        id: uuid("d", 1),
        start: 0,
        end: 12.5,
        text: "Welcome everyone.",
        editedText: null,
        confidence: 0.9,
        speakerId: null,
        editedSpeakerId: null,
        language: null,
        words: null,
      },
      {
        id: uuid("d", 2),
        start: 12.5,
        end: 42,
        text: "Let us start.",
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

function summaryFor(meetingId: string, transcriptId: string): Summary {
  return {
    id: uuid("e", 1),
    meetingId,
    transcriptId,
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    isActive: true,
    templateSnapshot: {
      templateId: uuid("f", 1),
      templateVersion: 1,
      resolvedSections: [
        { id: "decisions", title: "Decisions", instruction: "List decisions.", format: "bullets" },
      ],
      options: { tone: "neutral", length: "standard", outputLanguage: "auto" },
    },
    model: "gpt-oss",
    promptVersion: "1",
    createdAt: "2026-08-29T10:08:00.000Z",
    sections: [
      {
        sectionId: "decisions",
        title: "Decisions",
        format: "bullets",
        content: ["Ship the walking skeleton."],
        sourceSegmentIds: null,
      },
    ],
  };
}

function job(meetingId: string, type: Job["type"], status: Job["status"], index: number): Job {
  return {
    id: uuid("9", index),
    meetingId,
    type,
    status,
    progress: null,
    error:
      status === "failed"
        ? { code: "AUDIO_DECODE_FAILED", message: "The audio could not be decoded." }
        : null,
    resultId: null,
    createdAt: "2026-08-29T10:05:30.000Z",
    startedAt: "2026-08-29T10:05:31.000Z",
    finishedAt: status === "failed" ? "2026-08-29T10:05:40.000Z" : null,
  };
}

async function token(scope: { tenantId: string; userId: string }): Promise<string> {
  return signAccessToken(keys, {
    subject: scope.userId,
    tenantId: scope.tenantId,
    roles: ["quorum-user"],
  });
}

beforeAll(async () => {
  const seed = async (
    meetingId: string,
    scope: { tenantId: string; userId: string },
    title: string | null,
    createdAt: string,
    finalizedAt: string | null,
  ): Promise<void> => {
    await store.recordSession({
      meetingId,
      sessionId: meetingId,
      tenantId: scope.tenantId,
      userId: scope.userId,
      title,
      audioFormat: WEBM_OPUS,
      createdAt,
    });
    if (finalizedAt) await store.markFinalized(scope, meetingId, finalizedAt);
  };

  await seed(
    ACME_WEEKLY,
    ACME,
    "Weekly sync",
    "2026-08-29T10:00:00.000Z",
    "2026-08-29T10:05:00.000Z",
  );
  await seed(
    ACME_RETRO,
    ACME,
    "Sprint retro",
    "2026-08-28T10:00:00.000Z",
    "2026-08-28T10:05:00.000Z",
  );
  await seed(ACME_OPEN, ACME, null, "2026-08-30T10:00:00.000Z", null);
  await seed(
    GLOBEX_BOARD,
    GLOBEX,
    "Board meeting",
    "2026-08-27T10:00:00.000Z",
    "2026-08-27T11:00:00.000Z",
  );
  await seed(
    ACME_OTHER_USER,
    { tenantId: ACME.tenantId, userId: "user-2" },
    "Weekly sync",
    "2026-08-26T10:00:00.000Z",
    "2026-08-26T10:30:00.000Z",
  );

  const transcript = transcriptFor(ACME_WEEKLY);
  store.setPipeline(ACME_WEEKLY, {
    transcript,
    summaries: [summaryFor(ACME_WEEKLY, transcript.id)],
    jobs: [
      job(ACME_WEEKLY, "transcribe", "succeeded", 1),
      job(ACME_WEEKLY, "summarize", "succeeded", 2),
    ],
  });
  store.setPipeline(ACME_RETRO, { jobs: [job(ACME_RETRO, "transcribe", "failed", 3)] });

  app = await buildServer({
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
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("meeting list", () => {
  it("requires an access token", async () => {
    const response = await app.inject({ method: "GET", url: "/api/meetings" });
    expect(response.statusCode).toBe(401);
  });

  it("returns the caller's own meetings, newest first", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/meetings",
      headers: { authorization: `Bearer ${await token(ACME)}` },
    });
    expect(response.statusCode).toBe(200);
    const { meetings } = response.json() as { meetings: { id: string; title: string | null }[] };
    expect(meetings.map((meeting) => meeting.id)).toEqual([ACME_OPEN, ACME_WEEKLY, ACME_RETRO]);
  });

  it("excludes meetings of another tenant and of another user in the same tenant", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/meetings",
      headers: { authorization: `Bearer ${await token(ACME)}` },
    });
    const ids = (response.json() as { meetings: { id: string }[] }).meetings.map((m) => m.id);
    expect(ids).not.toContain(GLOBEX_BOARD);
    expect(ids).not.toContain(ACME_OTHER_USER);
  });

  it("derives the badge state per meeting", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/meetings",
      headers: { authorization: `Bearer ${await token(ACME)}` },
    });
    const meetings = (response.json() as { meetings: Record<string, unknown>[] }).meetings;
    const byId = new Map(meetings.map((meeting) => [meeting.id as string, meeting]));

    expect(byId.get(ACME_OPEN)).toMatchObject({ status: "recording", hasAudio: false });
    expect(byId.get(ACME_WEEKLY)).toMatchObject({
      status: "ready",
      hasAudio: true,
      language: "en",
      durationSeconds: 42,
    });
    expect(byId.get(ACME_RETRO)).toMatchObject({
      status: "failed",
      failure: { stage: "transcribe", code: "AUDIO_DECODE_FAILED" },
    });
  });

  it("searches meeting titles case-insensitively", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/meetings?q=RETRO",
      headers: { authorization: `Bearer ${await token(ACME)}` },
    });
    const ids = (response.json() as { meetings: { id: string }[] }).meetings.map((m) => m.id);
    expect(ids).toEqual([ACME_RETRO]);
  });

  it("does not let a search reach across the tenant boundary", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/meetings?q=Board",
      headers: { authorization: `Bearer ${await token(ACME)}` },
    });
    expect((response.json() as { meetings: unknown[] }).meetings).toEqual([]);
  });

  it("rejects a limit outside the allowed range", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/meetings?limit=5000",
      headers: { authorization: `Bearer ${await token(ACME)}` },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("meeting detail", () => {
  it("returns the transcript, the summaries and the job rows", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/meetings/${ACME_WEEKLY}`,
      headers: { authorization: `Bearer ${await token(ACME)}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      meeting: { id: string; status: string };
      transcript: { segments: unknown[] } | null;
      summaries: unknown[];
      jobs: unknown[];
    };
    expect(body.meeting).toMatchObject({ id: ACME_WEEKLY, status: "ready" });
    expect(body.transcript?.segments).toHaveLength(2);
    expect(body.summaries).toHaveLength(1);
    expect(body.jobs).toHaveLength(2);
  });

  it("answers 404 — not 403 — for a meeting of another tenant", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/meetings/${GLOBEX_BOARD}`,
      headers: { authorization: `Bearer ${await token(ACME)}` },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "meeting_not_found" });
  });

  it("answers 404 for a meeting of another user in the same tenant", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/meetings/${ACME_OTHER_USER}`,
      headers: { authorization: `Bearer ${await token(ACME)}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it("answers 404 for an id that is not a meeting id at all", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/meetings/not-a-uuid",
      headers: { authorization: `Bearer ${await token(ACME)}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it("requires an access token", async () => {
    const response = await app.inject({ method: "GET", url: `/api/meetings/${ACME_WEEKLY}` });
    expect(response.statusCode).toBe(401);
  });
});
