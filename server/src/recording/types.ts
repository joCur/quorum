import type { AudioFormat } from "@quorum/shared";

/**
 * Tenant/user scope of a recording connection (ADR-001: every data object carries
 * the tenant and user scope from day one).
 *
 * The recording plugin depends only on the provider interface below, so the source of the scope —
 * a validated access token in production, request headers in local development — is a single
 * argument in the server bootstrap.
 */
export interface RecordingContext {
  tenantId: string;
  userId: string;
}

/** The part of an incoming WebSocket upgrade request a context provider may look at. */
export interface RecordingContextRequest {
  headers: Record<string, string | string[] | undefined>;
  /** Set by the auth plugin when the upgrade carried a valid access token. */
  auth?: RecordingContext | undefined;
}

/** Resolves the recording context for an incoming WebSocket upgrade request. */
export interface RecordingContextProvider {
  resolve(request: RecordingContextRequest): Promise<RecordingContext>;
}

/** Persisted session metadata — written before the first chunk is acknowledged. */
export interface SessionRecord {
  sessionId: string;
  meetingId: string;
  tenantId: string;
  userId: string;
  meetingTitle: string | null;
  audioFormat: AudioFormat;
  createdAt: string;
  /** Wall-clock marks for pause/resume (ADR-002/ADR-003 audio-time mapping). */
  marks: Array<{ type: "pause" | "resume"; at: string }>;
}

/**
 * Object storage abstraction (S3-compatible; MinIO in the compose stack).
 *
 * Implementations must be idempotent: writing the same chunk key twice with the
 * same payload is a no-op from the client's point of view.
 */
export interface RecordingStorage {
  putSession(record: SessionRecord): Promise<void>;
  getSession(tenantId: string, userId: string, sessionId: string): Promise<SessionRecord | null>;
  putChunk(record: SessionRecord, seq: number, payload: Uint8Array): Promise<void>;
  /** Sequence numbers already persisted for this session, ascending. */
  listChunkSeqs(record: SessionRecord): Promise<number[]>;
  /** Writes the finalization manifest that the transcription worker consumes. */
  putManifest(record: SessionRecord, manifest: RecordingManifest): Promise<void>;
}

export interface RecordingManifest {
  sessionId: string;
  meetingId: string;
  tenantId: string;
  userId: string;
  audioFormat: AudioFormat;
  /** Number of chunk objects, i.e. `persistedSeq + 1`. */
  chunkCount: number;
  persistedSeq: number;
  chunkKeys: string[];
  marks: SessionRecord["marks"];
  finalizedAt: string;
}

/**
 * The part of the meeting store the recording endpoint uses.
 *
 * Object storage stays the source of truth for the recording itself; this registry is the
 * queryable index that makes a meeting listable and searchable. Kept as a narrow port so the
 * session handler never sees the read side of the store.
 */
export interface MeetingRegistry {
  recordSession(record: {
    meetingId: string;
    sessionId: string;
    tenantId: string;
    userId: string;
    title: string | null;
    audioFormat: AudioFormat;
    createdAt: string;
  }): Promise<void>;
  markFinalized(
    scope: { tenantId: string; userId: string },
    sessionId: string,
    finalizedAt: string,
  ): Promise<void>;
}

/** Thin queue port — the transcription worker that consumes these jobs lives elsewhere. */
export interface JobQueue {
  enqueueTranscribe(input: {
    jobId: string;
    meetingId: string;
    tenantId: string;
    userId: string;
    sessionId: string;
  }): Promise<void>;
}
