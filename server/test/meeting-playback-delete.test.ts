import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import type { AudioFormat } from "@quorum/shared";
import { buildServer } from "../src/app.js";
import { createTokenVerifier } from "../src/auth/token-verifier.js";
import { InMemoryRecordingStorage } from "../src/recording/storage/memory.js";
import { InMemoryJobQueue } from "../src/recording/queue/memory.js";
import { InMemoryMeetingStore } from "../src/meetings/memory.js";
import { RecordingSessionHandler } from "../src/recording/session.js";
import { AUDIENCE, INTERNAL_ISSUER, ISSUER, createTestKeyPair, signAccessToken } from "./keys.js";
import type { TestKeyPair } from "./keys.js";
import { FakeConnection, WEBM_HEADER, WEBM_OPUS, idSequence } from "./helpers.js";
import { encodeChunkFrame } from "../src/recording/frame.js";
import { audioKey } from "../src/recording/keys.js";

const keys: TestKeyPair = await createTestKeyPair();

const ACME = { tenantId: "tenant-acme", userId: "user-1" };
const GLOBEX = { tenantId: "tenant-globex", userId: "user-9" };

let app: FastifyInstance;
let storage: InMemoryRecordingStorage;
let store: InMemoryMeetingStore;
let meetingId: string;

/** The three chunk payloads written below, concatenated — what playback must return. */
const EXPECTED_AUDIO = Buffer.from([...WEBM_HEADER, 10, 11, 20, 21, 22, 30]);

async function token(scope: { tenantId: string; userId: string }): Promise<string> {
  return signAccessToken(keys, {
    subject: scope.userId,
    tenantId: scope.tenantId,
    roles: ["quorum-user"],
  });
}

/** Records a short meeting through the real session handler, so the stored bytes are real. */
async function recordMeeting(
  scope: { tenantId: string; userId: string },
  format: AudioFormat = WEBM_OPUS,
): Promise<string> {
  const connection = new FakeConnection();
  const handler = new RecordingSessionHandler(connection, {
    storage,
    queue: new InMemoryJobQueue(),
    meetings: store,
    context: scope,
    newId: idSequence(scope === ACME ? "a" : "b"),
    now: () => new Date("2026-08-29T10:00:00.000Z"),
  });

  await handler.handleText(
    JSON.stringify({
      type: "session.start",
      meetingTitle: "Weekly sync",
      audioFormat: format,
      clientInfo: { platform: "web-desktop", userAgent: "vitest" },
    }),
  );
  const sessionId = connection.last("session.ready")?.sessionId as string;

  const payloads = [
    Uint8Array.from([...WEBM_HEADER, 10, 11]),
    Uint8Array.from([20, 21, 22]),
    Uint8Array.from([30]),
  ];
  for (const [seq, payload] of payloads.entries()) {
    await handler.handleBinary(
      encodeChunkFrame({ sessionId, seq, timestampOffset: seq * 2 }, payload),
    );
  }
  await handler.handleText(JSON.stringify({ type: "session.end", sessionId, lastSeq: 2 }));

  const finalized = connection.last("session.finalized");
  if (!finalized) throw new Error("session was not finalized");
  return finalized.meetingId;
}

beforeEach(async () => {
  storage = new InMemoryRecordingStorage();
  store = new InMemoryMeetingStore();
  app = await buildServer({
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
  });
  await app.ready();
  meetingId = await recordMeeting(ACME);
});

afterEach(async () => {
  await app.close();
});

/** The session behind a meeting, read out of the store the way the route reads it. */
async function sessionOf(id: string): Promise<string> {
  const found = await store.findMeeting(ACME, id);
  if (!found) throw new Error("meeting is missing");
  return found.meeting.sessionId;
}

describe("audio playback", () => {
  it("streams the chunks back as one continuous recording", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/meetings/${meetingId}/audio`,
      headers: { authorization: `Bearer ${await token(ACME)}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("audio/webm");
    expect(response.headers["accept-ranges"]).toBe("bytes");
    expect(response.headers["content-length"]).toBe(String(EXPECTED_AUDIO.length));
    expect(response.rawPayload).toEqual(EXPECTED_AUDIO);
  });

  it("keeps the recording out of shared caches", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/meetings/${meetingId}/audio`,
      headers: { authorization: `Bearer ${await token(ACME)}` },
    });
    expect(response.headers["cache-control"]).toBe("private, no-store");
  });

  it("serves a byte range that spans several chunk objects", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/meetings/${meetingId}/audio`,
      headers: { authorization: `Bearer ${await token(ACME)}`, range: "bytes=4-7" },
    });

    expect(response.statusCode).toBe(206);
    expect(response.headers["content-range"]).toBe(`bytes 4-7/${EXPECTED_AUDIO.length}`);
    expect(response.rawPayload).toEqual(EXPECTED_AUDIO.subarray(4, 8));
  });

  it("answers 416 for a range beyond the recording", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/meetings/${meetingId}/audio`,
      headers: { authorization: `Bearer ${await token(ACME)}`, range: "bytes=9999-" },
    });
    expect(response.statusCode).toBe(416);
    expect(response.headers["content-range"]).toBe(`bytes */${EXPECTED_AUDIO.length}`);
  });

  it("serves the repackaged recording once the pipeline has replaced the chunks", async () => {
    // The shape a recording ends up in (ADR-010), staged by hand here: one audio object, no
    // chunks. Playback has to be indifferent to which of the two it finds.
    const scope = { ...ACME, sessionId: await sessionOf(meetingId) };
    const artifact = Buffer.from([...WEBM_HEADER, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (const key of [...storage.objects.keys()]) {
      if (key.includes("/chunks/")) storage.objects.delete(key);
    }
    storage.objects.set(audioKey(scope), new Uint8Array(artifact));

    const whole = await app.inject({
      method: "GET",
      url: `/api/meetings/${meetingId}/audio`,
      headers: { authorization: `Bearer ${await token(ACME)}` },
    });
    expect(whole.statusCode).toBe(200);
    expect(whole.headers["content-type"]).toBe("audio/webm");
    expect(whole.rawPayload).toEqual(artifact);

    // And a seek into it: the ranged read a real player makes once the file has a cue index.
    const ranged = await app.inject({
      method: "GET",
      url: `/api/meetings/${meetingId}/audio`,
      headers: { authorization: `Bearer ${await token(ACME)}`, range: "bytes=6-9" },
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers["content-range"]).toBe(`bytes 6-9/${artifact.length}`);
    expect(ranged.rawPayload).toEqual(artifact.subarray(6, 10));
  });

  it("requires an access token", async () => {
    const response = await app.inject({ method: "GET", url: `/api/meetings/${meetingId}/audio` });
    expect(response.statusCode).toBe(401);
  });

  it("does not serve another tenant's recording", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/meetings/${meetingId}/audio`,
      headers: { authorization: `Bearer ${await token(GLOBEX)}` },
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ error: "meeting_not_found" });
  });

  it("does not serve another user's recording inside the same tenant", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/api/meetings/${meetingId}/audio`,
      headers: {
        authorization: `Bearer ${await token({ tenantId: ACME.tenantId, userId: "user-2" })}`,
      },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe("deletion cascade", () => {
  it("removes every stored object and every row", async () => {
    expect(storage.objects.size).toBeGreaterThan(0);

    const response = await app.inject({
      method: "DELETE",
      url: `/api/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${await token(ACME)}` },
    });

    expect(response.statusCode).toBe(204);
    // ADR-001: nothing is left in storage — not the chunks, not session.json, not the manifest.
    expect([...storage.objects.keys()]).toEqual([]);
    expect(store.size).toBe(0);
    expect(await store.listMeetings(ACME)).toEqual([]);
    expect(await store.findMeeting(ACME, meetingId)).toBeNull();
  });

  it("makes the meeting and its audio unreachable afterwards", async () => {
    const authorization = `Bearer ${await token(ACME)}`;
    await app.inject({
      method: "DELETE",
      url: `/api/meetings/${meetingId}`,
      headers: { authorization },
    });

    const detail = await app.inject({
      method: "GET",
      url: `/api/meetings/${meetingId}`,
      headers: { authorization },
    });
    const audio = await app.inject({
      method: "GET",
      url: `/api/meetings/${meetingId}/audio`,
      headers: { authorization },
    });
    expect(detail.statusCode).toBe(404);
    expect(audio.statusCode).toBe(404);
  });

  it("is idempotent — deleting twice answers 404, not an error", async () => {
    const authorization = `Bearer ${await token(ACME)}`;
    await app.inject({
      method: "DELETE",
      url: `/api/meetings/${meetingId}`,
      headers: { authorization },
    });
    const second = await app.inject({
      method: "DELETE",
      url: `/api/meetings/${meetingId}`,
      headers: { authorization },
    });
    expect(second.statusCode).toBe(404);
  });

  it("does not let another tenant delete the meeting", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${await token(GLOBEX)}` },
    });

    expect(response.statusCode).toBe(404);
    // Nothing may have been touched — not even the audio objects.
    expect(storage.objects.size).toBeGreaterThan(0);
    expect(await store.findMeeting(ACME, meetingId)).not.toBeNull();
  });

  it("does not let another user of the same tenant delete the meeting", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: `/api/meetings/${meetingId}`,
      headers: {
        authorization: `Bearer ${await token({ tenantId: ACME.tenantId, userId: "user-2" })}`,
      },
    });
    expect(response.statusCode).toBe(404);
    expect(storage.objects.size).toBeGreaterThan(0);
  });

  it("leaves other meetings untouched", async () => {
    const other = await recordMeeting(GLOBEX);
    await app.inject({
      method: "DELETE",
      url: `/api/meetings/${meetingId}`,
      headers: { authorization: `Bearer ${await token(ACME)}` },
    });

    expect(await store.findMeeting(GLOBEX, other)).not.toBeNull();
    const audio = await app.inject({
      method: "GET",
      url: `/api/meetings/${other}/audio`,
      headers: { authorization: `Bearer ${await token(GLOBEX)}` },
    });
    expect(audio.statusCode).toBe(200);
  });

  it("requires an access token", async () => {
    const response = await app.inject({ method: "DELETE", url: `/api/meetings/${meetingId}` });
    expect(response.statusCode).toBe(401);
  });
});
