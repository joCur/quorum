import type { AudioFormat, ServerMessage } from "@quorum/shared";
import { encodeChunkFrame } from "../src/recording/frame.js";
import { RecordingSessionHandler, type Connection } from "../src/recording/session.js";
import { InMemoryRecordingStorage } from "../src/recording/storage/memory.js";
import { InMemoryJobQueue } from "../src/recording/queue/memory.js";

export const WEBM_HEADER = [0x1a, 0x45, 0xdf, 0xa3];
export const OGG_HEADER = [0x4f, 0x67, 0x67, 0x53];

export const WEBM_OPUS: AudioFormat = {
  codec: "opus",
  container: "webm",
  sampleRate: 48_000,
  channels: 1,
};

export class FakeConnection implements Connection {
  readonly sent: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;

  send(message: ServerMessage): void {
    this.sent.push(message);
  }

  close(code: number, reason: string): void {
    this.closed ??= { code, reason };
  }

  last<T extends ServerMessage["type"]>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    const matches = this.sent.filter((message) => message.type === type);
    return matches[matches.length - 1] as Extract<ServerMessage, { type: T }> | undefined;
  }
}

/** Deterministic UUID generator so tests can assert on ids. */
export function idSequence(prefix = "0"): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    const tail = String(counter).padStart(12, "0");
    return `${prefix.repeat(8)}-0000-4000-8000-${tail}`;
  };
}

export interface Harness {
  connection: FakeConnection;
  handler: RecordingSessionHandler;
  storage: InMemoryRecordingStorage;
  queue: InMemoryJobQueue;
}

export function createHarness(overrides: Partial<Harness> = {}): Harness {
  const connection = overrides.connection ?? new FakeConnection();
  const storage = overrides.storage ?? new InMemoryRecordingStorage();
  const queue = overrides.queue ?? new InMemoryJobQueue();
  const handler = new RecordingSessionHandler(connection, {
    storage,
    queue,
    context: { tenantId: "tenant-a", userId: "user-1" },
    newId: idSequence(),
    now: () => new Date("2026-08-29T10:00:00.000Z"),
  });
  return { connection, handler, storage, queue };
}

export async function startSession(
  harness: Harness,
  audioFormat: AudioFormat = WEBM_OPUS,
): Promise<string> {
  await harness.handler.handleText(
    JSON.stringify({
      type: "session.start",
      meetingTitle: "Weekly sync",
      audioFormat,
      clientInfo: { platform: "web-desktop", userAgent: "vitest" },
    }),
  );
  const ready = harness.connection.last("session.ready");
  if (!ready) throw new Error("session.ready was not sent");
  return ready.sessionId;
}

export function chunk(
  sessionId: string,
  seq: number,
  body: number[] = [1, 2, 3, 4, 5],
): Uint8Array {
  const payload = seq === 0 ? Uint8Array.from([...WEBM_HEADER, ...body]) : Uint8Array.from(body);
  return encodeChunkFrame({ sessionId, seq, timestampOffset: seq * 2 }, payload);
}
