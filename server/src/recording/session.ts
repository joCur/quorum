import { randomUUID } from "node:crypto";
import { ClientMessageSchema, type ClientMessage, type ServerMessage } from "@quorum/shared";
import {
  MAX_CHUNK_PAYLOAD_BYTES,
  checkAudioFormat,
  matchesContainer,
  type SupportedFormat,
} from "./audio-format.js";
import { parseChunkFrame } from "./frame.js";
import { chunkKey } from "./keys.js";
import type { JobQueue, RecordingContext, RecordingStorage, SessionRecord } from "./types.js";

/**
 * Close codes used by the recording endpoint. The protocol schema
 * (`recording-protocol.ts`) intentionally has no error message type, so failures
 * are reported through the WebSocket close frame.
 */
export const CLOSE_PROTOCOL_ERROR = 1002;
export const CLOSE_POLICY_VIOLATION = 1008;
export const CLOSE_MESSAGE_TOO_BIG = 1009;
export const CLOSE_INTERNAL_ERROR = 1011;
export const CLOSE_NORMAL = 1000;

/**
 * How far ahead of `persistedSeq` a client may run. Chunks are 1–2 s of audio
 * (ADR-002), so this is minutes of head room while still bounding the amount of
 * out-of-order state a single connection can force the server to hold.
 */
export const MAX_SEQ_GAP = 1024;

export interface Connection {
  send(message: ServerMessage): void;
  close(code: number, reason: string): void;
}

export interface SessionDeps {
  storage: RecordingStorage;
  queue: JobQueue;
  /**
   * Tenant/user scope. May be supplied later via `setContext` when it is
   * resolved asynchronously during the WebSocket upgrade.
   */
  context?: RecordingContext | undefined;
  now?: () => Date;
  newId?: () => string;
  logger?: { warn(details: Record<string, unknown>, message: string): void };
}

interface ActiveSession {
  record: SessionRecord;
  format: SupportedFormat;
  /** Highest sequence number for which all of 0..n are persisted, or -1. */
  persistedSeq: number;
  /** Sequence numbers persisted ahead of `persistedSeq` (out-of-order arrivals). */
  ahead: Set<number>;
  finalized: boolean;
}

/**
 * Protocol state machine for a single WebSocket connection. Kept free of any
 * Fastify or `ws` types so it can be exercised directly in unit tests with a
 * fake storage adapter.
 */
export class RecordingSessionHandler {
  private readonly deps: SessionDeps;
  private readonly connection: Connection;
  private session: ActiveSession | null = null;
  private context: RecordingContext | null;

  constructor(connection: Connection, deps: SessionDeps) {
    this.connection = connection;
    this.deps = deps;
    this.context = deps.context ?? null;
  }

  /** Supplies the tenant/user scope once authentication has resolved it. */
  setContext(context: RecordingContext): void {
    this.context = context;
  }

  private requireContext(): RecordingContext | null {
    if (!this.context) {
      this.connection.close(CLOSE_POLICY_VIOLATION, "unauthenticated connection");
      return null;
    }
    return this.context;
  }

  /** Current last persisted sequence number, or -1 when nothing is persisted. */
  get persistedSeq(): number {
    return this.session?.persistedSeq ?? -1;
  }

  get sessionId(): string | null {
    return this.session?.record.sessionId ?? null;
  }

  async handleText(raw: string): Promise<void> {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      this.connection.close(CLOSE_PROTOCOL_ERROR, "control message is not valid JSON");
      return;
    }
    const parsed = ClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.connection.close(
        CLOSE_PROTOCOL_ERROR,
        "control message does not match the protocol schema",
      );
      return;
    }
    await this.dispatch(parsed.data);
  }

  private async dispatch(message: ClientMessage): Promise<void> {
    switch (message.type) {
      case "session.start":
        await this.onStart(message);
        return;
      case "session.pause":
      case "session.resume":
        await this.onMark(
          message.type === "session.pause" ? "pause" : "resume",
          message.sessionId,
          message.at,
        );
        return;
      case "session.end":
        await this.onEnd(message.sessionId, message.lastSeq);
        return;
    }
  }

  private async onStart(message: Extract<ClientMessage, { type: "session.start" }>): Promise<void> {
    if (this.session) {
      this.connection.close(CLOSE_PROTOCOL_ERROR, "a session is already active on this connection");
      return;
    }
    const context = this.requireContext();
    if (!context) return;
    const check = checkAudioFormat(message.audioFormat);
    if (!check.ok) {
      this.connection.close(CLOSE_POLICY_VIOLATION, `rejected audio format: ${check.reason}`);
      return;
    }
    const newId = this.deps.newId ?? randomUUID;
    const record: SessionRecord = {
      sessionId: newId(),
      meetingId: newId(),
      tenantId: context.tenantId,
      userId: context.userId,
      meetingTitle: message.meetingTitle,
      audioFormat: message.audioFormat,
      createdAt: this.timestamp(),
      marks: [],
    };
    try {
      await this.deps.storage.putSession(record);
    } catch (error) {
      this.fail("failed to persist session metadata", error);
      return;
    }
    this.session = {
      record,
      format: check.format,
      persistedSeq: -1,
      ahead: new Set(),
      finalized: false,
    };
    this.connection.send({ type: "session.ready", sessionId: record.sessionId });
  }

  /**
   * Pause and resume carry wall-clock marks (ADR-002/ADR-003). A `session.resume`
   * for a session this connection does not know about is also the reconnect
   * path: session state is rebuilt from object storage — which is what lets a
   * client continue seamlessly after the server was killed mid-recording.
   */
  private async onMark(type: "pause" | "resume", sessionId: string, at: string): Promise<void> {
    if (!this.session || this.session.record.sessionId !== sessionId) {
      if (type !== "resume") {
        this.connection.close(CLOSE_PROTOCOL_ERROR, "unknown session for this connection");
        return;
      }
      const attached = await this.attach(sessionId);
      if (!attached) return;
    }
    const session = this.session as ActiveSession;
    session.record.marks.push({ type, at });
    try {
      await this.deps.storage.putSession(session.record);
    } catch (error) {
      this.fail("failed to persist session metadata", error);
      return;
    }
    this.ack();
  }

  /** Rebuilds session state from object storage after a reconnect. */
  private async attach(sessionId: string): Promise<boolean> {
    const context = this.requireContext();
    if (!context) return false;
    const { tenantId, userId } = context;
    let record: SessionRecord | null;
    try {
      record = await this.deps.storage.getSession(tenantId, userId, sessionId);
    } catch (error) {
      this.fail("failed to read session metadata", error);
      return false;
    }
    // Reading through the caller's tenant/user prefix is what enforces the scope:
    // another tenant simply cannot address this key.
    if (!record) {
      this.connection.close(CLOSE_POLICY_VIOLATION, "unknown session");
      return false;
    }
    const check = checkAudioFormat(record.audioFormat);
    if (!check.ok) {
      this.connection.close(CLOSE_POLICY_VIOLATION, `rejected audio format: ${check.reason}`);
      return false;
    }
    let seqs: number[];
    try {
      seqs = await this.deps.storage.listChunkSeqs(record);
    } catch (error) {
      this.fail("failed to list persisted chunks", error);
      return false;
    }
    const session: ActiveSession = {
      record,
      format: check.format,
      persistedSeq: -1,
      ahead: new Set(seqs),
      finalized: false,
    };
    this.session = session;
    this.advance(session);
    return true;
  }

  async handleBinary(frame: Uint8Array): Promise<void> {
    const session = this.session;
    if (!session) {
      this.connection.close(CLOSE_PROTOCOL_ERROR, "chunk received before session.start");
      return;
    }
    if (session.finalized) {
      this.connection.close(CLOSE_PROTOCOL_ERROR, "chunk received after session.end");
      return;
    }
    const parsed = parseChunkFrame(frame);
    if (!parsed.ok) {
      this.connection.close(CLOSE_PROTOCOL_ERROR, parsed.reason);
      return;
    }
    const { meta, payload } = parsed.chunk;
    if (meta.sessionId !== session.record.sessionId) {
      this.connection.close(
        CLOSE_POLICY_VIOLATION,
        "chunk session id does not match the active session",
      );
      return;
    }
    if (payload.length > MAX_CHUNK_PAYLOAD_BYTES) {
      this.connection.close(
        CLOSE_MESSAGE_TOO_BIG,
        "chunk payload exceeds the per-chunk size limit",
      );
      return;
    }
    // The first chunk of a recording carries the container header; later chunks
    // are continuation bytes of the same stream.
    if (meta.seq === 0 && !matchesContainer(session.format, payload)) {
      this.connection.close(
        CLOSE_POLICY_VIOLATION,
        `chunk does not match the announced "${session.record.audioFormat.container}" container`,
      );
      return;
    }
    if (meta.seq > session.persistedSeq + MAX_SEQ_GAP) {
      this.connection.close(
        CLOSE_POLICY_VIOLATION,
        "sequence number too far ahead of the last persisted chunk",
      );
      return;
    }
    // Duplicates are idempotent: a reconnecting client may re-send chunks it has
    // already had acknowledged.
    if (meta.seq <= session.persistedSeq || session.ahead.has(meta.seq)) {
      this.ack();
      return;
    }
    try {
      await this.deps.storage.putChunk(session.record, meta.seq, payload);
    } catch (error) {
      this.fail("failed to persist chunk", error);
      return;
    }
    // Only now — after a successful write — does the chunk count as persisted.
    session.ahead.add(meta.seq);
    this.advance(session);
  }

  /** Moves `persistedSeq` forward over the contiguous run of persisted chunks. */
  private advance(session: ActiveSession): void {
    while (session.ahead.has(session.persistedSeq + 1)) {
      session.persistedSeq += 1;
      session.ahead.delete(session.persistedSeq);
    }
    this.ack();
  }

  private async onEnd(sessionId: string, lastSeq: number): Promise<void> {
    const session = this.session;
    if (!session || session.record.sessionId !== sessionId) {
      this.connection.close(CLOSE_PROTOCOL_ERROR, "unknown session for this connection");
      return;
    }
    // Incomplete recording: do not finalize, re-acknowledge so the client
    // re-sends everything after `persistedSeq`.
    if (lastSeq > session.persistedSeq) {
      this.ack();
      return;
    }
    const scope = {
      tenantId: session.record.tenantId,
      userId: session.record.userId,
      sessionId: session.record.sessionId,
    };
    const chunkKeys: string[] = [];
    for (let seq = 0; seq <= session.persistedSeq; seq += 1) {
      chunkKeys.push(chunkKey(scope, seq));
    }
    const newId = this.deps.newId ?? randomUUID;
    const jobId = newId();
    try {
      await this.deps.storage.putManifest(session.record, {
        sessionId: session.record.sessionId,
        meetingId: session.record.meetingId,
        tenantId: session.record.tenantId,
        userId: session.record.userId,
        audioFormat: session.record.audioFormat,
        chunkCount: session.persistedSeq + 1,
        persistedSeq: session.persistedSeq,
        chunkKeys,
        marks: session.record.marks,
        finalizedAt: this.timestamp(),
      });
      await this.deps.queue.enqueueTranscribe({
        jobId,
        meetingId: session.record.meetingId,
        tenantId: session.record.tenantId,
        userId: session.record.userId,
        sessionId: session.record.sessionId,
      });
    } catch (error) {
      this.fail("failed to finalize session", error);
      return;
    }
    session.finalized = true;
    this.connection.send({
      type: "session.finalized",
      sessionId: session.record.sessionId,
      meetingId: session.record.meetingId,
      jobId,
    });
    this.connection.close(CLOSE_NORMAL, "session finalized");
  }

  private ack(): void {
    const session = this.session;
    if (!session || session.persistedSeq < 0) return;
    this.connection.send({
      type: "chunk.ack",
      sessionId: session.record.sessionId,
      persistedSeq: session.persistedSeq,
    });
  }

  private fail(message: string, error: unknown): void {
    this.deps.logger?.warn({ err: error, sessionId: this.sessionId }, message);
    this.connection.close(CLOSE_INTERNAL_ERROR, message);
  }

  private timestamp(): string {
    return (this.deps.now?.() ?? new Date()).toISOString();
  }
}
