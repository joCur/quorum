import { describe, expect, it } from "vitest";
import {
  CHUNK_HEADER_BYTES,
  ChunkAckSchema,
  SessionFinalizedSchema,
  SessionReadySchema,
} from "@quorum/shared";
import { encodeChunkFrame, parseChunkFrame } from "../src/recording/frame.js";
import { chunkKey, manifestKey, sessionKey } from "../src/recording/keys.js";
import {
  CLOSE_MESSAGE_TOO_BIG,
  CLOSE_POLICY_VIOLATION,
  CLOSE_PROTOCOL_ERROR,
  MAX_SEQ_GAP,
  RecordingSessionHandler,
} from "../src/recording/session.js";
import { MAX_CHUNK_PAYLOAD_BYTES } from "../src/recording/audio-format.js";
import { InMemoryJobQueue } from "../src/recording/queue/memory.js";
import {
  FakeConnection,
  OGG_HEADER,
  WEBM_OPUS,
  chunk,
  createHarness,
  idSequence,
  startSession,
} from "./helpers.js";

describe("handshake", () => {
  it("answers session.start with a schema-conformant session.ready", async () => {
    const harness = createHarness();
    const sessionId = await startSession(harness);

    expect(SessionReadySchema.parse(harness.connection.sent[0])).toEqual({
      type: "session.ready",
      sessionId,
    });
    expect(
      harness.storage.objects.has(
        sessionKey({ tenantId: "tenant-a", userId: "user-1", sessionId }),
      ),
    ).toBe(true);
  });

  it("scopes object keys by tenant and user (ADR-001)", async () => {
    const harness = createHarness();
    const sessionId = await startSession(harness);
    await harness.handler.handleBinary(chunk(sessionId, 0));

    const keys = [...harness.storage.objects.keys()];
    expect(keys.every((key) => key.startsWith("tenants/tenant-a/users/user-1/sessions/"))).toBe(
      true,
    );
    expect(keys).toContain(chunkKey({ tenantId: "tenant-a", userId: "user-1", sessionId }, 0));
  });

  /**
   * The template a meeting is summarized with is chosen before recording and travels in
   * `session.start`. Storing it with the session rather than attaching it afterwards is what
   * keeps the choice and the recording from disagreeing: they are written in one step.
   */
  it("stores the summary template chosen for this meeting with the session", async () => {
    const harness = createHarness();
    const chosen = "9a3f2c1d-4b5e-4a77-8c91-2d6e5f4a3b21";
    await harness.handler.handleText(
      JSON.stringify({
        type: "session.start",
        meetingTitle: "Weekly sync",
        summaryTemplateId: chosen,
        audioFormat: WEBM_OPUS,
        clientInfo: { platform: "web-desktop", userAgent: "vitest" },
      }),
    );
    const ready = harness.connection.last("session.ready");
    const stored = harness.storage.objects.get(
      sessionKey({ tenantId: "tenant-a", userId: "user-1", sessionId: ready?.sessionId ?? "" }),
    );

    expect(JSON.parse(new TextDecoder().decode(stored)).summaryTemplateId).toBe(chosen);
  });

  /**
   * A client built before the field existed — a tab left open across a deploy — has to keep
   * recording. Its sessions carry no choice, which the summary side reads as "follow the user's
   * default"; that is why the field is optional rather than required.
   */
  it("accepts a session.start without the template field and records no choice", async () => {
    const harness = createHarness();
    const sessionId = await startSession(harness);
    const stored = harness.storage.objects.get(
      sessionKey({ tenantId: "tenant-a", userId: "user-1", sessionId }),
    );

    expect(JSON.parse(new TextDecoder().decode(stored)).summaryTemplateId).toBeNull();
  });

  it("rejects a session.start whose template id is not an id at all", async () => {
    const harness = createHarness();
    await harness.handler.handleText(
      JSON.stringify({
        type: "session.start",
        meetingTitle: null,
        summaryTemplateId: "the short one",
        audioFormat: WEBM_OPUS,
        clientInfo: { platform: "web-desktop", userAgent: "vitest" },
      }),
    );
    expect(harness.connection.closed?.code).toBe(CLOSE_PROTOCOL_ERROR);
  });

  it("rejects a control message that does not match the protocol schema", async () => {
    const harness = createHarness();
    await harness.handler.handleText(JSON.stringify({ type: "session.start" }));
    expect(harness.connection.closed?.code).toBe(CLOSE_PROTOCOL_ERROR);
  });

  it("rejects a chunk that arrives before session.start", async () => {
    const harness = createHarness();
    await harness.handler.handleBinary(chunk("00000000-0000-4000-8000-000000000001", 0));
    expect(harness.connection.closed?.code).toBe(CLOSE_PROTOCOL_ERROR);
  });

  it("refuses to start a session without an authenticated context", async () => {
    const connection = new FakeConnection();
    const harness = createHarness({ connection });
    const handler = new RecordingSessionHandler(connection, {
      storage: harness.storage,
      queue: harness.queue,
      newId: idSequence(),
    });
    await handler.handleText(
      JSON.stringify({
        type: "session.start",
        meetingTitle: null,
        audioFormat: WEBM_OPUS,
        clientInfo: { platform: "web-desktop", userAgent: "vitest" },
      }),
    );
    expect(connection.closed?.code).toBe(CLOSE_POLICY_VIOLATION);
  });
});

describe("chunk persistence and acknowledgement", () => {
  it("acknowledges every chunk with the last persisted sequence number", async () => {
    const harness = createHarness();
    const sessionId = await startSession(harness);

    for (const seq of [0, 1, 2]) {
      await harness.handler.handleBinary(chunk(sessionId, seq));
      expect(ChunkAckSchema.parse(harness.connection.last("chunk.ack"))).toEqual({
        type: "chunk.ack",
        sessionId,
        persistedSeq: seq,
      });
    }
  });

  it("does not acknowledge a chunk whose write failed", async () => {
    const harness = createHarness();
    const sessionId = await startSession(harness);
    await harness.handler.handleBinary(chunk(sessionId, 0));

    harness.storage.failNextWrite = true;
    await harness.handler.handleBinary(chunk(sessionId, 1));

    expect(harness.connection.last("chunk.ack")?.persistedSeq).toBe(0);
    expect(harness.handler.persistedSeq).toBe(0);
    expect(harness.connection.closed).not.toBeNull();
  });

  it("is idempotent for duplicate sequence numbers", async () => {
    const harness = createHarness();
    const sessionId = await startSession(harness);
    await harness.handler.handleBinary(chunk(sessionId, 0));
    await harness.handler.handleBinary(chunk(sessionId, 1));
    const objectCount = harness.storage.objects.size;

    await harness.handler.handleBinary(chunk(sessionId, 0));
    await harness.handler.handleBinary(chunk(sessionId, 1));

    expect(harness.storage.objects.size).toBe(objectCount);
    expect(harness.connection.last("chunk.ack")?.persistedSeq).toBe(1);
    expect(harness.connection.closed).toBeNull();
  });

  it("holds persistedSeq at the contiguous run when chunks arrive out of order", async () => {
    const harness = createHarness();
    const sessionId = await startSession(harness);

    await harness.handler.handleBinary(chunk(sessionId, 0));
    await harness.handler.handleBinary(chunk(sessionId, 2));
    await harness.handler.handleBinary(chunk(sessionId, 3));
    // Chunk 1 is still missing, so the client may not drop its buffer past 0.
    expect(harness.connection.last("chunk.ack")?.persistedSeq).toBe(0);

    await harness.handler.handleBinary(chunk(sessionId, 1));
    expect(harness.connection.last("chunk.ack")?.persistedSeq).toBe(3);
  });

  it("rejects a sequence number far ahead of the last persisted chunk", async () => {
    const harness = createHarness();
    const sessionId = await startSession(harness);
    await harness.handler.handleBinary(chunk(sessionId, MAX_SEQ_GAP + 1));
    expect(harness.connection.closed?.code).toBe(CLOSE_POLICY_VIOLATION);
  });

  it("rejects a chunk carrying a foreign session id", async () => {
    const harness = createHarness();
    await startSession(harness);
    await harness.handler.handleBinary(chunk("11111111-1111-4111-8111-111111111111", 0));
    expect(harness.connection.closed?.code).toBe(CLOSE_POLICY_VIOLATION);
  });
});

describe("validation", () => {
  it("rejects an unsupported audio format at handshake time", async () => {
    const harness = createHarness();
    await harness.handler.handleText(
      JSON.stringify({
        type: "session.start",
        meetingTitle: null,
        audioFormat: { codec: "pcm", container: "wav", sampleRate: 48_000, channels: 1 },
        clientInfo: { platform: "web-desktop", userAgent: "vitest" },
      }),
    );
    expect(harness.connection.closed?.code).toBe(CLOSE_POLICY_VIOLATION);
    expect(harness.connection.closed?.reason).toContain("unsupported container");
  });

  it("rejects a codec that does not belong to the announced container", async () => {
    const harness = createHarness();
    await harness.handler.handleText(
      JSON.stringify({
        type: "session.start",
        meetingTitle: null,
        audioFormat: { codec: "aac", container: "webm", sampleRate: 48_000, channels: 1 },
        clientInfo: { platform: "web-desktop", userAgent: "vitest" },
      }),
    );
    expect(harness.connection.closed?.code).toBe(CLOSE_POLICY_VIOLATION);
  });

  it("rejects a first chunk that does not match the announced container", async () => {
    const harness = createHarness();
    const sessionId = await startSession(harness);
    // Announced WebM, sent an Ogg header — no arbitrary blob uploads.
    await harness.handler.handleBinary(
      encodeChunkFrame(
        { sessionId, seq: 0, timestampOffset: 0 },
        Uint8Array.from([...OGG_HEADER, 9, 9]),
      ),
    );
    expect(harness.connection.closed?.code).toBe(CLOSE_POLICY_VIOLATION);
    expect(harness.storage.objects.size).toBe(1); // session.json only
  });

  it("rejects an oversized chunk payload", async () => {
    const harness = createHarness();
    const sessionId = await startSession(harness);
    await harness.handler.handleBinary(
      encodeChunkFrame(
        { sessionId, seq: 1, timestampOffset: 2 },
        new Uint8Array(MAX_CHUNK_PAYLOAD_BYTES + 1),
      ),
    );
    expect(harness.connection.closed?.code).toBe(CLOSE_MESSAGE_TOO_BIG);
  });

  it("rejects a frame shorter than the protocol header", async () => {
    const harness = createHarness();
    const sessionId = await startSession(harness);
    void sessionId;
    await harness.handler.handleBinary(new Uint8Array(CHUNK_HEADER_BYTES));
    expect(harness.connection.closed?.code).toBe(CLOSE_PROTOCOL_ERROR);
  });

  it("round-trips the binary chunk header", () => {
    const meta = {
      sessionId: "3f0d5b8a-2f61-4c0e-9a1a-1f9f6c0f3f21",
      seq: 7,
      timestampOffset: 14.5,
    };
    const frame = encodeChunkFrame(meta, Uint8Array.from([1, 2, 3]));
    const parsed = parseChunkFrame(frame);
    expect(parsed.ok && parsed.chunk.meta).toEqual(meta);
    expect(parsed.ok && [...parsed.chunk.payload]).toEqual([1, 2, 3]);
  });
});

describe("reconnect", () => {
  it("resumes from persistedSeq after the connection was replaced", async () => {
    const first = createHarness();
    const sessionId = await startSession(first);
    await first.handler.handleBinary(chunk(sessionId, 0));
    await first.handler.handleBinary(chunk(sessionId, 1));

    // New connection, same storage — as after a server restart mid-recording.
    const connection = new FakeConnection();
    const handler = new RecordingSessionHandler(connection, {
      storage: first.storage,
      queue: first.queue,
      context: { tenantId: "tenant-a", userId: "user-1" },
      newId: idSequence(),
      // Five minutes after the session started: the reconnect happens well inside the maximum
      // session duration, so the resume continues the recording instead of stopping it.
      now: () => new Date("2026-08-29T10:05:00.000Z"),
    });

    await handler.handleText(
      JSON.stringify({ type: "session.resume", sessionId, at: "2026-08-29T10:05:00.000Z" }),
    );

    expect(connection.last("chunk.ack")?.persistedSeq).toBe(1);
    await handler.handleBinary(chunk(sessionId, 2));
    expect(connection.last("chunk.ack")?.persistedSeq).toBe(2);
  });

  it("re-acknowledges chunks the client re-sends after a reconnect", async () => {
    const harness = createHarness();
    const sessionId = await startSession(harness);
    await harness.handler.handleBinary(chunk(sessionId, 0));
    await harness.handler.handleBinary(chunk(sessionId, 1));

    const connection = new FakeConnection();
    const handler = new RecordingSessionHandler(connection, {
      storage: harness.storage,
      queue: harness.queue,
      context: { tenantId: "tenant-a", userId: "user-1" },
      now: () => new Date("2026-08-29T10:05:00.000Z"),
    });
    await handler.handleText(
      JSON.stringify({ type: "session.resume", sessionId, at: "2026-08-29T10:05:00.000Z" }),
    );
    // The client had not seen the ack for chunk 1 and sends it again.
    await handler.handleBinary(chunk(sessionId, 1));
    expect(connection.last("chunk.ack")?.persistedSeq).toBe(1);
    expect(connection.closed).toBeNull();
  });

  it("refuses to attach to a session of another tenant", async () => {
    const harness = createHarness();
    const sessionId = await startSession(harness);

    const connection = new FakeConnection();
    const handler = new RecordingSessionHandler(connection, {
      storage: harness.storage,
      queue: harness.queue,
      context: { tenantId: "tenant-b", userId: "user-9" },
    });
    await handler.handleText(
      JSON.stringify({ type: "session.resume", sessionId, at: "2026-08-29T10:05:00.000Z" }),
    );
    expect(connection.closed?.code).toBe(CLOSE_POLICY_VIOLATION);
  });
});

describe("finalization", () => {
  it("writes a manifest, enqueues a transcribe job and reports session.finalized", async () => {
    const harness = createHarness();
    const sessionId = await startSession(harness);
    await harness.handler.handleBinary(chunk(sessionId, 0));
    await harness.handler.handleBinary(chunk(sessionId, 1));

    await harness.handler.handleText(
      JSON.stringify({ type: "session.end", sessionId, lastSeq: 1 }),
    );

    const finalized = SessionFinalizedSchema.parse(harness.connection.last("session.finalized"));
    expect(finalized.sessionId).toBe(sessionId);
    expect(harness.queue.enqueued).toHaveLength(1);
    expect(harness.queue.enqueued[0]).toMatchObject({
      jobId: finalized.jobId,
      meetingId: finalized.meetingId,
      tenantId: "tenant-a",
      userId: "user-1",
      sessionId,
    });

    const manifest = harness.storage.objects.get(
      manifestKey({ tenantId: "tenant-a", userId: "user-1", sessionId }),
    );
    expect(manifest).toBeDefined();
    expect(JSON.parse(new TextDecoder().decode(manifest))).toMatchObject({
      chunkCount: 2,
      persistedSeq: 1,
    });
  });

  it("does not finalize while chunks are still missing", async () => {
    const harness = createHarness();
    const sessionId = await startSession(harness);
    await harness.handler.handleBinary(chunk(sessionId, 0));

    await harness.handler.handleText(
      JSON.stringify({ type: "session.end", sessionId, lastSeq: 5 }),
    );

    expect(harness.connection.last("session.finalized")).toBeUndefined();
    expect(harness.connection.last("chunk.ack")?.persistedSeq).toBe(0);
    expect(harness.queue.enqueued).toHaveLength(0);
  });

  it("does not report finalization when enqueueing fails", async () => {
    const queue = new InMemoryJobQueue();
    const harness = createHarness({ queue });
    const sessionId = await startSession(harness);
    await harness.handler.handleBinary(chunk(sessionId, 0));

    queue.failNextEnqueue = true;
    await harness.handler.handleText(
      JSON.stringify({ type: "session.end", sessionId, lastSeq: 0 }),
    );

    expect(harness.connection.last("session.finalized")).toBeUndefined();
    expect(harness.connection.closed).not.toBeNull();
  });

  it("rejects chunks after the session was finalized", async () => {
    const harness = createHarness();
    const sessionId = await startSession(harness);
    await harness.handler.handleBinary(chunk(sessionId, 0));
    await harness.handler.handleText(
      JSON.stringify({ type: "session.end", sessionId, lastSeq: 0 }),
    );

    const connection = new FakeConnection();
    void connection;
    await harness.handler.handleBinary(chunk(sessionId, 1));
    expect(
      harness.storage.objects.has(
        chunkKey({ tenantId: "tenant-a", userId: "user-1", sessionId }, 1),
      ),
    ).toBe(false);
  });
});

describe("pause and resume marks", () => {
  it("records wall-clock marks in the session metadata", async () => {
    const harness = createHarness();
    const sessionId = await startSession(harness);
    await harness.handler.handleBinary(chunk(sessionId, 0));

    await harness.handler.handleText(
      JSON.stringify({ type: "session.pause", sessionId, at: "2026-08-29T10:01:00.000Z" }),
    );
    await harness.handler.handleText(
      JSON.stringify({ type: "session.resume", sessionId, at: "2026-08-29T10:02:00.000Z" }),
    );

    const record = await harness.storage.getSession("tenant-a", "user-1", sessionId);
    expect(record?.marks).toEqual([
      { type: "pause", at: "2026-08-29T10:01:00.000Z" },
      { type: "resume", at: "2026-08-29T10:02:00.000Z" },
    ]);
  });
});
