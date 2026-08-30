import "fake-indexeddb/auto";
import { CHUNK_HEADER_BYTES, type AudioFormat, type ServerMessage } from "@quorum/shared";
import { openChunkBuffer, type ChunkBuffer } from "../src/features/recording/chunk-buffer";
import type { SocketLike } from "../src/features/recording/protocol-client";

export const SESSION_ID = "11111111-2222-4333-8444-555555555555";

export const AUDIO_FORMAT: AudioFormat = {
  codec: "opus",
  container: "webm",
  sampleRate: 48_000,
  channels: 1,
};

/** A fresh, isolated IndexedDB per test — `fake-indexeddb` runs in memory. */
export async function freshBuffer(): Promise<ChunkBuffer> {
  const { IDBFactory } = await import("fake-indexeddb");
  return openChunkBuffer(new IDBFactory());
}

/**
 * Minimal WebSocket stand-in. Tests drive it explicitly: nothing opens, closes
 * or delivers a message unless the test says so.
 */
export class FakeSocket implements SocketLike {
  binaryType = "";
  readonly sent: Array<string | Uint8Array> = [];
  closed: { code?: number | undefined; reason?: string | undefined } | null = null;

  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string | ArrayBufferLike | ArrayBufferView): void {
    this.sent.push(typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer));
  }

  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
    // The close event carries the code and the reason, which is how the server names a limit.
    this.onclose?.({
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason }),
    });
  }

  open(): void {
    this.onopen?.({});
  }

  deliver(message: ServerMessage): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }

  /** Control messages sent on this socket, parsed. */
  controlMessages(): Array<Record<string, unknown>> {
    return this.sent
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => JSON.parse(entry) as Record<string, unknown>);
  }

  /** Sequence numbers of the binary chunk frames sent on this socket. */
  sentSeqs(): number[] {
    return this.sent
      .filter((entry): entry is Uint8Array => entry instanceof Uint8Array)
      .map((frame) =>
        new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(16, true),
      );
  }

  /** Payload bytes of the binary chunk frames sent on this socket. */
  sentPayloads(): Uint8Array[] {
    return this.sent
      .filter((entry): entry is Uint8Array => entry instanceof Uint8Array)
      .map((frame) => frame.subarray(CHUNK_HEADER_BYTES));
  }
}

/** Collects the sockets a client opens so tests can drive each one. */
export function socketFactory(): {
  create: (url: string) => SocketLike;
  sockets: FakeSocket[];
  latest: () => FakeSocket;
} {
  const sockets: FakeSocket[] = [];
  return {
    create: (url: string) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    sockets,
    latest: () => {
      const socket = sockets.at(-1);
      if (!socket) throw new Error("no socket was created");
      return socket;
    },
  };
}

/** Lets queued promise callbacks run — the client awaits IndexedDB internally. */
export async function settle(times = 6): Promise<void> {
  for (let index = 0; index < times; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
