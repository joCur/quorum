import type { AudioFormat } from "@quorum/shared";

/**
 * Tenant/user scope of a recording connection (ADR-001: every data object carries
 * the tenant and user scope from day one).
 *
 * Ticket #3 introduces the real JWT auth plugin. Until both branches land, the
 * recording plugin only depends on this interface, so wiring the real provider is
 * a one-line change in the server bootstrap.
 */
export interface RecordingContext {
  tenantId: string;
  userId: string;
}

/** Resolves the recording context for an incoming WebSocket upgrade request. */
export interface RecordingContextProvider {
  resolve(request: {
    headers: Record<string, string | string[] | undefined>;
  }): Promise<RecordingContext>;
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

/** Thin queue port — the transcription worker itself is ticket #6. */
export interface JobQueue {
  enqueueTranscribe(input: {
    jobId: string;
    meetingId: string;
    tenantId: string;
    userId: string;
    sessionId: string;
  }): Promise<void>;
}
