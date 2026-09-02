import type { AudioFormat } from "@quorum/shared";
import type { KeyScope } from "./keys.js";

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
  /**
   * Template chosen for this meeting before recording started, or `null` when
   * the recorder made no choice. Written once at `session.start` and never
   * updated: it describes what was asked for at capture time.
   */
  summaryTemplateId: string | null;
  /**
   * Language chosen for this meeting before recording started, or `null` when the recorder made
   * no choice. Written once at `session.start` alongside the template, and never updated, for the
   * same reason: it describes what was asked for at capture time.
   */
  language: string | null;
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
  /**
   * Every object stored under one session prefix — chunks, `session.json`, `manifest.json`.
   *
   * Playback and the deletion cascade both work from this listing rather than from the manifest:
   * the listing is what actually exists, and the cascade of ADR-001 has to remove objects that
   * no manifest mentions just as reliably as the ones it does.
   */
  listSessionObjects(scope: KeyScope): Promise<StoredObject[]>;
  /** Reads one object, or the inclusive byte range `[from, to]` of it. */
  readObject(key: string, range?: ByteRange): Promise<Uint8Array>;
  /** Removes objects. A key that is already gone is not an error — deletion is idempotent. */
  deleteObjects(keys: readonly string[]): Promise<void>;
}

/** One stored object and its size, from a prefix listing. */
export interface StoredObject {
  key: string;
  size: number;
}

/** Inclusive byte range, like the HTTP `Range` header it serves. */
export interface ByteRange {
  from: number;
  to: number;
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
  /**
   * Records how much a session has consumed so far, so the quotas have something durable to read.
   *
   * Optional on this port: an instance without a meeting index records but enforces no quota,
   * which is the same trade its listability already makes here.
   *
   * Implementations must be **monotonic** — a stored value may only ever grow. A reconnect
   * restarts the connection's own counters at zero, and a session must not appear to shrink
   * because of it.
   */
  recordUsage?(
    scope: { tenantId: string; userId: string },
    sessionId: string,
    usage: RecordingUsage,
  ): Promise<void>;
  /** What this user has already consumed. `monthStart` bounds the recording-time half. */
  readUsage?(
    scope: { tenantId: string; userId: string },
    monthStart: string,
  ): Promise<AccountUsage>;
}

/**
 * The part of the user's preferences the recording endpoint reads.
 *
 * Narrow on purpose, like `MeetingRegistry`: the session handler resolves one meeting's
 * transcription language and has no business seeing, let alone writing, the rest of a user's
 * settings.
 */
export interface UserPreferences {
  findSettings(scope: {
    tenantId: string;
    userId: string;
  }): Promise<{ transcriptionLanguage: string | null; vocabulary: string[] }>;
}

/** What one recording session has consumed. */
export interface RecordingUsage {
  /** Bytes of audio persisted for this session. */
  audioBytes: number;
  /** Seconds of audio recorded — audio time, so pauses do not count. */
  recordedSeconds: number;
}

/** What a user has consumed across their meetings. */
export interface AccountUsage {
  /** Bytes of stored audio over all of the user's meetings. */
  storageBytes: number;
  /** Seconds recorded in meetings created since the start of the current month. */
  monthRecordedSeconds: number;
}

/** Thin queue port — the transcription worker that consumes these jobs lives elsewhere. */
export interface JobQueue {
  enqueueTranscribe(input: {
    jobId: string;
    meetingId: string;
    tenantId: string;
    userId: string;
    sessionId: string;
    /**
     * Language to transcribe in, as far as this side of the system can say: the meeting's own
     * choice, or the user's default when the meeting made none. `null` leaves the remaining links
     * of the chain — the deployment default, then autodetect — to the worker, which is where that
     * configuration lives (ADR-005).
     *
     * It travels in the payload rather than being looked up when the job runs, so a job that is
     * retried an hour later transcribes what was asked for at the time and not what the user has
     * since changed their default to.
     */
    language: string | null;
    /**
     * The user's custom vocabulary as it stood when the recording was handed over. Resolved here
     * for the same reason as the language: a job retried later must bias towards what was
     * configured at recording time, not towards a list that has been edited since.
     */
    vocabulary: string[];
  }): Promise<void>;
  /**
   * Asks for a summary of an existing transcript — the "Regenerate" action.
   *
   * The pipeline enqueues the first summary itself once a transcript is stored; this covers the
   * second and later ones, with a template the user picked (ADR-004 §3: a meeting may have many
   * summaries, one active per template).
   */
  enqueueSummarize(input: {
    jobId: string;
    meetingId: string;
    tenantId: string;
    userId: string;
    sessionId: string;
    transcriptId: string;
    templateId: string;
    createdAt: string;
  }): Promise<void>;
}
