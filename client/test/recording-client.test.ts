import { describe, expect, it } from "vitest";
import { CHUNK_HEADER_BYTES } from "@quorum/shared";
import {
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  RecordingClient,
  backoffDelay,
  type RecordingClientError,
  type RecordingClientStatus,
} from "../src/features/recording/protocol-client";
import type { ChunkBuffer } from "../src/features/recording/chunk-buffer";
import { AUDIO_FORMAT, SESSION_ID, freshBuffer, settle, socketFactory } from "./helpers";

interface Harness {
  client: RecordingClient;
  buffer: ChunkBuffer;
  factory: ReturnType<typeof socketFactory>;
  statuses: RecordingClientStatus[];
  /** Reconnect delays the client asked for, in order. */
  delays: number[];
  runTimers: () => void;
}

async function harness(
  options: { onError?: (error: RecordingClientError) => void } = {},
): Promise<Harness> {
  const buffer = await freshBuffer();
  const factory = socketFactory();
  const statuses: RecordingClientStatus[] = [];
  const delays: number[] = [];
  const timers: Array<() => void> = [];

  const client = new RecordingClient({
    url: "wss://quorum.test/ws/recording",
    buffer,
    createSocket: factory.create,
    clientInfo: { platform: "web-desktop", userAgent: "test" },
    now: () => Date.parse("2026-08-29T10:00:00.000Z"),
    random: () => 1,
    schedule: (callback, delay) => {
      delays.push(delay);
      timers.push(callback);
      return timers.length;
    },
    cancel: () => undefined,
    onStatusChange: (status) => statuses.push(status),
    ...(options.onError ? { onError: options.onError } : {}),
  });

  return {
    client,
    buffer,
    factory,
    statuses,
    delays,
    runTimers: () => {
      const queued = timers.splice(0, timers.length);
      for (const callback of queued) callback();
    },
  };
}

/** Opens the socket and completes the handshake. */
async function startSession(context: Harness): Promise<void> {
  const started = context.client.start(
    { meetingTitle: "Weekly sync", summaryTemplateId: null, language: "de" },
    AUDIO_FORMAT,
  );
  context.factory.latest().open();
  context.factory.latest().deliver({ type: "session.ready", sessionId: SESSION_ID });
  await started;
  await settle();
}

const payload = (byte: number) => new Uint8Array([byte, byte, byte]);

describe("recording client — handshake", () => {
  it("announces the audio format and resolves with the session id", async () => {
    const context = await harness();
    await startSession(context);

    const [start] = context.factory.latest().controlMessages();
    expect(start).toMatchObject({
      type: "session.start",
      meetingTitle: "Weekly sync",
      // What the recorder chose before capture travels with the handshake, so the pipeline
      // transcribes the meeting in the language the screen was showing.
      language: "de",
      audioFormat: AUDIO_FORMAT,
    });
    expect(context.client.status.sessionId).toBe(SESSION_ID);
    expect(await context.buffer.getSession(SESSION_ID)).not.toBeNull();
  });

  it("writes a chunk to the buffer before it goes on the wire", async () => {
    const context = await harness();
    await startSession(context);
    await context.client.pushChunk(payload(1), 0, 1);

    const frames = context.factory.latest().sentPayloads();
    expect(frames).toHaveLength(1);
    expect(frames[0]).toEqual(payload(1));
    expect(await context.buffer.chunksFrom(SESSION_ID, 0)).toHaveLength(1);
  });

  it("encodes the protocol header the server expects", async () => {
    const context = await harness();
    await startSession(context);
    await context.client.pushChunk(payload(7), 12.5, 1);

    const frame = context.factory
      .latest()
      .sent.find((entry): entry is Uint8Array => entry instanceof Uint8Array);
    const view = new DataView(frame!.buffer, frame!.byteOffset, frame!.byteLength);
    expect(view.getUint32(16, true)).toBe(0);
    expect(view.getFloat64(20, true)).toBe(12.5);
    expect(frame!.length).toBe(CHUNK_HEADER_BYTES + 3);
  });
});

describe("recording client — acknowledgement bookkeeping", () => {
  it("keeps chunks buffered until they are acknowledged", async () => {
    const context = await harness();
    await startSession(context);
    for (let seq = 0; seq < 4; seq += 1) {
      await context.client.pushChunk(payload(seq), seq, 1);
    }

    expect(context.client.status.pendingChunks).toBe(4);
    expect(context.client.status.pendingSeconds).toBe(4);

    context.factory.latest().deliver({ type: "chunk.ack", sessionId: SESSION_ID, persistedSeq: 1 });
    await settle();

    expect(context.client.status.persistedSeq).toBe(1);
    expect(context.client.status.pendingChunks).toBe(2);
    expect((await context.buffer.chunksFrom(SESSION_ID, 0)).map((chunk) => chunk.seq)).toEqual([
      2, 3,
    ]);
  });

  it("ignores an acknowledgement that goes backwards", async () => {
    const context = await harness();
    await startSession(context);
    for (let seq = 0; seq < 3; seq += 1) {
      await context.client.pushChunk(payload(seq), seq, 1);
    }

    const socket = context.factory.latest();
    socket.deliver({ type: "chunk.ack", sessionId: SESSION_ID, persistedSeq: 2 });
    await settle();
    socket.deliver({ type: "chunk.ack", sessionId: SESSION_ID, persistedSeq: 0 });
    await settle();

    expect(context.client.status.persistedSeq).toBe(2);
    expect(await context.buffer.chunksFrom(SESSION_ID, 0)).toEqual([]);
  });

  it("drops the local session only once the server reports it finalized", async () => {
    const context = await harness();
    await startSession(context);
    await context.client.pushChunk(payload(0), 0, 1);

    const socket = context.factory.latest();
    socket.deliver({ type: "chunk.ack", sessionId: SESSION_ID, persistedSeq: 0 });
    await settle();
    expect(await context.buffer.getSession(SESSION_ID)).not.toBeNull();

    socket.deliver({
      type: "session.finalized",
      sessionId: SESSION_ID,
      meetingId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      jobId: "99999999-8888-4777-8666-555555555555",
    });
    await settle();
    expect(await context.buffer.getSession(SESSION_ID)).toBeNull();
  });
});

describe("recording client — offline and reconnect", () => {
  it("keeps buffering while the socket is down and never loses a chunk", async () => {
    const context = await harness();
    await startSession(context);
    await context.client.pushChunk(payload(0), 0, 1);
    context.factory.latest().deliver({ type: "chunk.ack", sessionId: SESSION_ID, persistedSeq: 0 });
    await settle();

    context.factory.latest().close();
    for (let seq = 1; seq <= 3; seq += 1) {
      await context.client.pushChunk(payload(seq), seq, 1);
    }

    expect(context.client.status.connection).toBe("reconnecting");
    expect(context.client.status.pendingChunks).toBe(3);
    expect((await context.buffer.chunksFrom(SESSION_ID, 0)).map((chunk) => chunk.seq)).toEqual([
      1, 2, 3,
    ]);
  });

  it("reattaches and resends everything after persistedSeq", async () => {
    const context = await harness();
    await startSession(context);
    for (let seq = 0; seq < 3; seq += 1) {
      await context.client.pushChunk(payload(seq), seq, 1);
    }
    context.factory.latest().deliver({ type: "chunk.ack", sessionId: SESSION_ID, persistedSeq: 0 });
    await settle();

    context.factory.latest().close();
    context.runTimers();
    const reconnected = context.factory.latest();
    reconnected.open();
    await settle();

    expect(reconnected.controlMessages()[0]).toMatchObject({
      type: "session.resume",
      sessionId: SESSION_ID,
    });
    // Chunk 0 was acknowledged and evicted; 1 and 2 are sent again.
    expect(reconnected.sentSeqs()).toEqual([1, 2]);
  });

  it("finalizes after the buffer has drained when the stop happened offline", async () => {
    const context = await harness();
    await startSession(context);
    await context.client.pushChunk(payload(0), 0, 1);

    context.factory.latest().close();
    context.client.end();

    context.runTimers();
    const reconnected = context.factory.latest();
    reconnected.open();
    await settle();

    const types = reconnected.controlMessages().map((message) => message.type);
    expect(types).toContain("session.resume");
    expect(types).toContain("session.end");
    expect(reconnected.sentSeqs()).toEqual([0]);
  });

  it("stops reconnecting once the session is finalized", async () => {
    const context = await harness();
    await startSession(context);
    const socket = context.factory.latest();
    socket.deliver({
      type: "session.finalized",
      sessionId: SESSION_ID,
      meetingId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      jobId: "99999999-8888-4777-8666-555555555555",
    });
    await settle();
    socket.close();

    expect(context.factory.sockets).toHaveLength(1);
    expect(context.client.status.connection).toBe("closed");
  });

  it("backs off exponentially and stops growing at the cap", async () => {
    const context = await harness();
    await startSession(context);

    for (let attempt = 0; attempt < 4; attempt += 1) {
      context.factory.latest().close();
      context.runTimers();
    }

    expect(context.delays).toEqual([
      INITIAL_BACKOFF_MS,
      INITIAL_BACKOFF_MS * 2,
      INITIAL_BACKOFF_MS * 4,
      INITIAL_BACKOFF_MS * 8,
    ]);
    expect(backoffDelay(20, 1)).toBe(MAX_BACKOFF_MS);
    // Jitter only ever shortens the wait, so a reconnect is never delayed past
    // the cap.
    expect(backoffDelay(3, 0)).toBe((INITIAL_BACKOFF_MS * 8) / 2);
  });
});

describe("recording client — resuming a buffered session", () => {
  it("picks the sequence numbering up where the interrupted session left off", async () => {
    const first = await harness();
    await startSession(first);
    for (let seq = 0; seq < 3; seq += 1) {
      await first.client.pushChunk(payload(seq), seq, 1);
    }
    first.factory.latest().deliver({ type: "chunk.ack", sessionId: SESSION_ID, persistedSeq: 0 });
    await settle();

    // A new client over the same buffer stands in for a reloaded tab.
    const factory = socketFactory();
    const resumed = new RecordingClient({
      url: "wss://quorum.test/ws/recording",
      buffer: first.buffer,
      createSocket: factory.create,
      now: () => Date.parse("2026-08-29T10:05:00.000Z"),
    });

    const stored = await first.buffer.getSession(SESSION_ID);
    await resumed.resume(stored!);
    factory.latest().open();
    await settle();

    expect(resumed.status.persistedSeq).toBe(0);
    expect(resumed.status.pendingChunks).toBe(2);
    expect(factory.latest().sentSeqs()).toEqual([1, 2]);

    await resumed.pushChunk(payload(3), 3, 1);
    expect(factory.latest().sentSeqs()).toEqual([1, 2, 3]);
  });
});

describe("recording client — pause and resume", () => {
  it("marks the pause and the resume with wall-clock timestamps", async () => {
    const context = await harness();
    await startSession(context);
    await context.client.pushChunk(payload(0), 0, 1);

    context.client.pause();
    context.client.resumeMark();

    const marks = context.factory
      .latest()
      .controlMessages()
      .filter((message) => message["type"] !== "session.start");
    expect(marks).toEqual([
      { type: "session.pause", sessionId: SESSION_ID, at: "2026-08-29T10:00:00.000Z" },
      { type: "session.resume", sessionId: SESSION_ID, at: "2026-08-29T10:00:00.000Z" },
    ]);
  });

  it("continues the chunk sequence across a pause instead of restarting it", async () => {
    const context = await harness();
    await startSession(context);
    await context.client.pushChunk(payload(0), 0, 1);
    await context.client.pushChunk(payload(1), 1, 1);

    // Nothing is captured while paused, so no chunk is pushed between the two marks — the
    // sequence simply carries on where the break interrupted it.
    context.client.pause();
    context.client.resumeMark();

    await context.client.pushChunk(payload(2), 2, 1);
    await context.client.pushChunk(payload(3), 3, 1);

    expect(context.factory.latest().sentSeqs()).toEqual([0, 1, 2, 3]);
    // One session in the buffer, not two: a pause never splits a recording.
    expect(await context.buffer.listUnfinishedSessions()).toHaveLength(1);
  });

  it("ignores a mark when no session is open, rather than inventing one", async () => {
    const context = await harness();

    context.client.pause();
    context.client.resumeMark();

    expect(context.factory.sockets).toHaveLength(0);
  });
});

describe("recording client — limits", () => {
  it("reports the limit the server refused the session with and stops reconnecting", async () => {
    const errors: RecordingClientError[] = [];
    const context = await harness({ onError: (error) => errors.push(error) });
    await startSession(context);

    // 1008 with the code as the reason — how every limit refusal reaches the client.
    context.factory.latest().close(1008, "limit.parallel_sessions_exceeded");
    await settle();

    expect(errors).toEqual([
      {
        code: "limit",
        message: "limit.parallel_sessions_exceeded",
        limit: "limit.parallel_sessions_exceeded",
      },
    ]);
    // A refusal is the server's final answer: asking again, faster, is exactly what the limit is
    // there to prevent.
    context.runTimers();
    expect(context.factory.sockets).toHaveLength(1);
    expect(context.client.status.connection).toBe("closed");
  });

  it("reports the duration hard stop, which arrives after the session was finalized", async () => {
    const errors: RecordingClientError[] = [];
    const context = await harness({ onError: (error) => errors.push(error) });
    await startSession(context);
    const socket = context.factory.latest();

    socket.deliver({
      type: "session.finalized",
      sessionId: SESSION_ID,
      meetingId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      jobId: "99999999-8888-4777-8666-555555555555",
    });
    await settle();
    // The server finalizes first and then closes naming the limit, so the recording is complete
    // and the client still learns why it ended.
    socket.close(1000, "limit.session_duration_exceeded");
    await settle();

    expect(context.client.status.finalized).toBe(true);
    expect(errors.at(0)?.limit).toBe("limit.session_duration_exceeded");
  });

  it("treats an ordinary close as a reconnect, not as a limit", async () => {
    const errors: RecordingClientError[] = [];
    const context = await harness({ onError: (error) => errors.push(error) });
    await startSession(context);

    context.factory.latest().close(1006, "connection lost");
    await settle();

    expect(errors).toEqual([]);
    expect(context.client.status.connection).toBe("reconnecting");
  });
});
