import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import WebSocket from "ws";
import { ServerMessageSchema, type ServerMessage } from "@quorum/shared";
import { buildServer } from "../src/app.js";
import { HeaderRecordingContextProvider } from "../src/recording/context-provider.js";
import { InMemoryRecordingStorage } from "../src/recording/storage/memory.js";
import { InMemoryJobQueue } from "../src/recording/queue/memory.js";
import { encodeChunkFrame } from "../src/recording/frame.js";
import { WEBM_HEADER, WEBM_OPUS } from "./helpers.js";

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function connect(storage: InMemoryRecordingStorage, queue: InMemoryJobQueue) {
  app = await buildServer({
    storage,
    queue,
    contextProvider: new HeaderRecordingContextProvider(true),
  });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind a port");

  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/recording`, {
    headers: { "x-quorum-tenant-id": "tenant-a", "x-quorum-user-id": "user-1" },
  });
  const messages: ServerMessage[] = [];
  socket.on("message", (data: Buffer) => {
    messages.push(ServerMessageSchema.parse(JSON.parse(data.toString("utf8"))));
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => {
      resolve();
    });
    socket.once("error", reject);
  });
  return { socket, messages };
}

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out waiting for a server message");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("WebSocket recording endpoint", () => {
  it("runs a full recording over a real WebSocket connection", async () => {
    const storage = new InMemoryRecordingStorage();
    const queue = new InMemoryJobQueue();
    const { socket, messages } = await connect(storage, queue);

    socket.send(
      JSON.stringify({
        type: "session.start",
        meetingTitle: "Weekly sync",
        audioFormat: WEBM_OPUS,
        clientInfo: { platform: "web-desktop", userAgent: "vitest" },
      }),
    );
    const ready = await waitFor(() => messages.find((message) => message.type === "session.ready"));
    const sessionId = ready.sessionId;

    socket.send(
      encodeChunkFrame(
        { sessionId, seq: 0, timestampOffset: 0 },
        Uint8Array.from([...WEBM_HEADER, 1, 2]),
      ),
      { binary: true },
    );
    socket.send(
      encodeChunkFrame({ sessionId, seq: 1, timestampOffset: 2 }, Uint8Array.from([3, 4])),
      {
        binary: true,
      },
    );
    await waitFor(() =>
      messages.find((message) => message.type === "chunk.ack" && message.persistedSeq === 1),
    );

    socket.send(JSON.stringify({ type: "session.end", sessionId, lastSeq: 1 }));
    const finalized = await waitFor(() =>
      messages.find((message) => message.type === "session.finalized"),
    );

    expect(finalized.sessionId).toBe(sessionId);
    expect(queue.enqueued).toHaveLength(1);
    socket.close();
  });

  it("closes the connection when the tenant headers are missing", async () => {
    app = await buildServer({
      storage: new InMemoryRecordingStorage(),
      queue: new InMemoryJobQueue(),
      contextProvider: new HeaderRecordingContextProvider(true),
    });
    await app.listen({ port: 0, host: "127.0.0.1" });
    const address = app.server.address();
    if (!address || typeof address === "string") throw new Error("server did not bind a port");

    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws/recording`);
    const code = await new Promise<number>((resolve, reject) => {
      socket.once("close", resolve);
      socket.once("error", reject);
    });
    expect(code).toBe(1008);
  });
});
