import {
  ServerMessageSchema,
  bearerSubprotocolOffer,
  type AudioFormat,
  type ClientMessage,
  type LimitErrorCode,
  type ServerMessage,
} from "@quorum/shared";
import { asLimitCode } from "@/features/limits/messages";
import { encodeChunkFrame } from "@/features/recording/frame";
import type { BufferedSession, ChunkBuffer } from "@/features/recording/chunk-buffer";

/**
 * WebSocket client for the chunk-streaming protocol (ADR-002).
 *
 * The rules it exists to keep:
 *
 * - a chunk is written to the local buffer before it is sent, and removed only
 *   after `chunk.ack` names it as persisted;
 * - a lost connection never stops capture — chunks keep accumulating locally and
 *   are resent after reconnecting, resuming from the server's `persistedSeq`;
 * - the socket is the only thing that reconnects: sequence numbers, audio time
 *   and the buffer survive it untouched.
 *
 * It deliberately knows nothing about React, `MediaRecorder` or the DOM, so the
 * bookkeeping can be tested directly against a fake socket.
 */

export type ConnectionState = "idle" | "connecting" | "open" | "reconnecting" | "closed";

export interface SocketLike {
  binaryType: string;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  /** The close event; its `code` and `reason` are what a limit refusal travels in. */
  onclose: ((event: { code?: number; reason?: string }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export interface RecordingClientOptions {
  url: string;
  /** Access token; sent as a WebSocket subprotocol, never in the query string. */
  accessToken?: string | undefined;
  buffer: ChunkBuffer;
  createSocket: (url: string, protocols?: string[]) => SocketLike;
  /** Platform description sent with `session.start`. */
  clientInfo?: { platform: string; userAgent: string } | undefined;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => number;
  cancel?: (handle: number) => void;
  /** Deterministic jitter source; defaults to `Math.random`. */
  random?: () => number;
  onStatusChange?: (status: RecordingClientStatus) => void;
  onFinalized?: (result: { sessionId: string; meetingId: string; jobId: string }) => void;
  onError?: (error: RecordingClientError) => void;
}

/** What the recorder decided before the microphone opened. */
export interface NewSession {
  meetingTitle: string | null;
  /** Template for this meeting's summary; `null` follows the user's default. */
  summaryTemplateId: string | null;
  /**
   * Language this meeting is transcribed in — `auto` to have it detected, `null` to state
   * nothing and leave the whole chain to the server.
   */
  language: string | null;
}

export interface RecordingClientStatus {
  connection: ConnectionState;
  sessionId: string | null;
  /** Last sequence number handed to the client, or -1. */
  lastSeq: number;
  /** Last sequence number the server confirmed, or -1. */
  persistedSeq: number;
  /** Chunks held locally and not yet acknowledged. */
  pendingChunks: number;
  /** Audio duration held locally and not yet acknowledged, in seconds. */
  pendingSeconds: number;
  finalized: boolean;
}

export interface RecordingClientError {
  code: "connect-failed" | "buffer-write-failed" | "protocol" | "limit";
  message: string;
  /** Set when the server closed the session because a configured limit was reached. */
  limit?: LimitErrorCode;
}

export const INITIAL_BACKOFF_MS = 500;
export const MAX_BACKOFF_MS = 15_000;

export class RecordingClient {
  private readonly options: RecordingClientOptions;
  private readonly now: () => number;
  private readonly schedule: (callback: () => void, delayMs: number) => number;
  private readonly cancel: (handle: number) => void;
  private readonly random: () => number;

  private socket: SocketLike | null = null;
  private connection: ConnectionState = "idle";
  private session: BufferedSession | null = null;
  private nextSeq = 0;
  private persistedSeq = -1;
  private finalized = false;
  private stopped = false;
  private attempt = 0;
  private retryHandle: number | null = null;
  /** Duration in seconds per unacknowledged chunk, keyed by sequence number. */
  private readonly pending = new Map<number, number>();
  private readyResolvers: Array<(sessionId: string) => void> = [];

  constructor(options: RecordingClientOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
    // Cast because the DOM and Node typings disagree on the handle type; only
    // the browser implementation is ever used at runtime.
    this.schedule =
      options.schedule ??
      ((callback, delay) => globalThis.setTimeout(callback, delay) as unknown as number);
    this.cancel = options.cancel ?? ((handle) => globalThis.clearTimeout(handle));
    this.random = options.random ?? Math.random;
  }

  get status(): RecordingClientStatus {
    let pendingSeconds = 0;
    for (const duration of this.pending.values()) pendingSeconds += duration;
    return {
      connection: this.connection,
      sessionId: this.session?.sessionId ?? null,
      lastSeq: this.nextSeq - 1,
      persistedSeq: this.persistedSeq,
      pendingChunks: this.pending.size,
      pendingSeconds,
      finalized: this.finalized,
    };
  }

  /**
   * Opens a connection and starts a new session. Resolves with the session id
   * the server assigned in `session.ready`.
   */
  async start(session: NewSession, audioFormat: AudioFormat): Promise<string> {
    this.stopped = false;
    const ready = new Promise<string>((resolve) => {
      this.readyResolvers.push(resolve);
    });
    this.pendingStart = { ...session, audioFormat };
    this.connect();
    return ready;
  }

  /**
   * Reattaches to a session whose audio is still buffered locally — the path
   * taken after a reload or a crash. The server rebuilds its state from object
   * storage, so everything still held here can simply be resent.
   */
  async resume(session: BufferedSession): Promise<void> {
    this.stopped = false;
    this.session = session;
    this.persistedSeq = session.persistedSeq;
    this.nextSeq = session.lastSeq + 1;
    this.pending.clear();
    for (const chunk of await this.options.buffer.chunksFrom(session.sessionId, 0)) {
      this.pending.set(chunk.seq, chunk.duration);
    }
    this.emit();
    this.connect();
  }

  /**
   * Buffers a chunk locally and sends it when the socket is open. Capture never
   * waits on the network: an offline client only fills the buffer.
   */
  async pushChunk(payload: Uint8Array, timestampOffset: number, duration: number): Promise<void> {
    const session = this.session;
    if (!session || this.finalized) return;
    const seq = this.nextSeq;
    this.nextSeq += 1;

    try {
      await this.options.buffer.appendChunk({
        sessionId: session.sessionId,
        seq,
        timestampOffset,
        duration,
        // Structured cloning needs a standalone buffer, not a view into a
        // possibly larger one.
        payload: payload.slice().buffer,
      });
    } catch (cause) {
      // A chunk that cannot be stored locally must not be pretended away: the
      // caller stops the recording rather than silently dropping audio.
      this.options.onError?.({
        code: "buffer-write-failed",
        message: cause instanceof Error ? cause.message : String(cause),
      });
      throw cause;
    }

    this.pending.set(seq, duration);
    this.sendFrame(session.sessionId, seq, timestampOffset, payload);
    this.emit();
  }

  pause(): void {
    if (!this.session) return;
    this.sendControl({
      type: "session.pause",
      sessionId: this.session.sessionId,
      at: new Date(this.now()).toISOString(),
    });
  }

  resumeMark(): void {
    if (!this.session) return;
    this.sendControl({
      type: "session.resume",
      sessionId: this.session.sessionId,
      at: new Date(this.now()).toISOString(),
    });
  }

  /**
   * Requests finalization. The server only finalizes once it holds every chunk
   * up to `lastSeq`; until then it just re-acknowledges and the buffer drains.
   */
  end(): void {
    const session = this.session;
    if (!session) return;
    this.endRequested = true;
    this.sendControl({
      type: "session.end",
      sessionId: session.sessionId,
      lastSeq: this.nextSeq - 1,
    });
  }

  /** Stops reconnecting and closes the socket. Buffered audio is left intact. */
  dispose(): void {
    this.stopped = true;
    if (this.retryHandle !== null) {
      this.cancel(this.retryHandle);
      this.retryHandle = null;
    }
    this.socket?.close(1000, "client disposed");
    this.socket = null;
    this.setConnection("closed");
  }

  private pendingStart: (NewSession & { audioFormat: AudioFormat }) | null = null;
  private endRequested = false;

  private connect(): void {
    if (this.stopped || this.socket) return;
    this.setConnection(this.attempt === 0 ? "connecting" : "reconnecting");

    // The subprotocol marker and the order the token follows it in are the shared wire contract.
    const protocols = this.options.accessToken
      ? bearerSubprotocolOffer(this.options.accessToken)
      : undefined;

    let socket: SocketLike;
    try {
      socket = this.options.createSocket(this.options.url, protocols);
    } catch (cause) {
      this.options.onError?.({
        code: "connect-failed",
        message: cause instanceof Error ? cause.message : String(cause),
      });
      this.scheduleReconnect();
      return;
    }

    socket.binaryType = "arraybuffer";
    socket.onopen = () => this.onOpen();
    socket.onmessage = (event) => this.onMessage(event.data);
    socket.onclose = (event) => this.onClose(event);
    socket.onerror = () => {
      // A socket error is always followed by a close event, which owns the
      // reconnect decision; reporting it twice would be noise.
    };
    this.socket = socket;
  }

  private onOpen(): void {
    this.attempt = 0;
    this.setConnection("open");

    if (this.pendingStart) {
      this.sendControl({
        type: "session.start",
        meetingTitle: this.pendingStart.meetingTitle,
        summaryTemplateId: this.pendingStart.summaryTemplateId,
        language: this.pendingStart.language,
        audioFormat: this.pendingStart.audioFormat,
        clientInfo: this.options.clientInfo ?? { platform: "web", userAgent: "" },
      });
      return;
    }

    if (this.session) {
      // `session.resume` for a session this connection does not know is the
      // server's reattach path: it rebuilds state from storage and acknowledges.
      this.resumeMark();
      void this.flush();
    }
  }

  private onClose(event?: { reason?: string }): void {
    this.socket = null;

    // A limit refusal is the server's final answer, not a hiccup: the reason names the limit and
    // reconnecting would only ask the same question again, faster. It is read before the
    // finalized check, because the hard stop at the maximum session length arrives exactly that
    // way — a `session.finalized` message, then a close frame naming the limit behind it.
    const limit = asLimitCode(event?.reason);
    if (limit !== null) {
      this.stopped = true;
      this.setConnection("closed");
      this.options.onError?.({ code: "limit", message: limit, limit });
      return;
    }

    if (this.stopped || this.finalized) {
      this.setConnection("closed");
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.finalized) return;
    this.socket = null;
    this.setConnection("reconnecting");
    const delay = backoffDelay(this.attempt, this.random());
    this.attempt += 1;
    this.retryHandle = this.schedule(() => {
      this.retryHandle = null;
      this.connect();
    }, delay);
  }

  /** Resends everything still unacknowledged, in sequence order. */
  private async flush(): Promise<void> {
    const session = this.session;
    if (!session) return;
    const chunks = await this.options.buffer.chunksFrom(session.sessionId, this.persistedSeq + 1);
    for (const chunk of chunks) {
      this.sendFrame(
        session.sessionId,
        chunk.seq,
        chunk.timestampOffset,
        new Uint8Array(chunk.payload),
      );
    }
    // A stop that happened while offline still needs finalizing once the buffer
    // has drained.
    if (this.endRequested) this.end();
  }

  private onMessage(data: unknown): void {
    if (typeof data !== "string") return;
    let parsed: ServerMessage;
    try {
      const result = ServerMessageSchema.safeParse(JSON.parse(data));
      if (!result.success) {
        this.options.onError?.({ code: "protocol", message: "unexpected message from server" });
        return;
      }
      parsed = result.data;
    } catch {
      this.options.onError?.({ code: "protocol", message: "server message is not valid JSON" });
      return;
    }

    switch (parsed.type) {
      case "session.ready":
        void this.onReady(parsed.sessionId);
        return;
      case "chunk.ack":
        void this.onAck(parsed.persistedSeq);
        return;
      case "session.finalized":
        this.finalized = true;
        void this.options.buffer.deleteSession(parsed.sessionId);
        this.emit();
        this.options.onFinalized?.({
          sessionId: parsed.sessionId,
          meetingId: parsed.meetingId,
          jobId: parsed.jobId,
        });
        return;
      case "transcript.partial":
        // Reserved in the schema and never sent in V1.
        return;
    }
  }

  private async onReady(sessionId: string): Promise<void> {
    const start = this.pendingStart;
    this.pendingStart = null;
    if (!start) return;

    const session: BufferedSession = {
      sessionId,
      meetingTitle: start.meetingTitle,
      audioFormat: start.audioFormat,
      startedAt: new Date(this.now()).toISOString(),
      lastSeq: -1,
      persistedSeq: -1,
      finalized: false,
    };
    await this.options.buffer.putSession(session);
    this.session = session;
    this.emit();

    const resolvers = this.readyResolvers;
    this.readyResolvers = [];
    for (const resolve of resolvers) resolve(sessionId);
  }

  private async onAck(persistedSeq: number): Promise<void> {
    const session = this.session;
    if (!session || persistedSeq <= this.persistedSeq) return;
    this.persistedSeq = persistedSeq;
    for (const seq of [...this.pending.keys()]) {
      if (seq <= persistedSeq) this.pending.delete(seq);
    }
    // Only an acknowledgement may delete local audio.
    await this.options.buffer.evictThrough(session.sessionId, persistedSeq);
    this.emit();
  }

  private sendFrame(
    sessionId: string,
    seq: number,
    timestampOffset: number,
    payload: Uint8Array,
  ): void {
    if (this.connection !== "open" || !this.socket) return;
    this.socket.send(encodeChunkFrame({ sessionId, seq, timestampOffset }, payload));
  }

  private sendControl(message: ClientMessage): void {
    if (this.connection !== "open" || !this.socket) return;
    this.socket.send(JSON.stringify(message));
  }

  private setConnection(next: ConnectionState): void {
    if (this.connection === next) return;
    this.connection = next;
    this.emit();
  }

  private emit(): void {
    this.options.onStatusChange?.(this.status);
  }
}

/** Exponential backoff with jitter, capped so reconnects stay responsive. */
export function backoffDelay(attempt: number, jitter: number): number {
  const base = Math.min(INITIAL_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS);
  // Full jitter over the lower half of the window: never longer than the cap,
  // never a thundering herd of clients retrying in lockstep.
  return Math.round(base * (0.5 + 0.5 * jitter));
}
