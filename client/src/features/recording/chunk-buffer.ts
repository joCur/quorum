import type { AudioFormat } from "@quorum/shared";

/**
 * Crash-safe local buffer for audio chunks (ADR-002).
 *
 * Every chunk is written here *before* it is sent and deleted only after the
 * server acknowledges it with `chunk.ack`. That is what makes a dropped network
 * connection, a closed tab or a browser crash cost nothing but the seconds that
 * were still in flight.
 */

export const DATABASE_NAME = "quorum-recording";
export const DATABASE_VERSION = 1;
export const SESSION_STORE = "sessions";
export const CHUNK_STORE = "chunks";

export interface BufferedSession {
  sessionId: string;
  meetingTitle: string | null;
  audioFormat: AudioFormat;
  /** Wall-clock start, ISO 8601 — used by the recovery card after a crash. */
  startedAt: string;
  /** Highest sequence number handed to the buffer so far, or -1. */
  lastSeq: number;
  /** Last sequence number the server confirmed as persisted, or -1. */
  persistedSeq: number;
  /** True once `session.finalized` arrived; the entry is then disposable. */
  finalized: boolean;
}

export interface BufferedChunk {
  sessionId: string;
  seq: number;
  /** Seconds of audio time since the recording started, pauses excluded. */
  timestampOffset: number;
  /** Audio duration this chunk covers, in seconds. */
  duration: number;
  payload: ArrayBuffer;
}

export interface PendingStats {
  count: number;
  /** Audio duration held locally but not yet acknowledged, in seconds. */
  durationSeconds: number;
  bytes: number;
}

function request<T>(source: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    source.onsuccess = () => resolve(source.result);
    source.onerror = () => reject(source.error ?? new Error("IndexedDB request failed"));
  });
}

function finish(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

export async function openChunkBuffer(factory: IDBFactory = indexedDB): Promise<ChunkBuffer> {
  const open = factory.open(DATABASE_NAME, DATABASE_VERSION);
  open.onupgradeneeded = () => {
    const database = open.result;
    if (!database.objectStoreNames.contains(SESSION_STORE)) {
      database.createObjectStore(SESSION_STORE, { keyPath: "sessionId" });
    }
    if (!database.objectStoreNames.contains(CHUNK_STORE)) {
      // The compound key gives ordered range scans per session for free, which
      // is exactly what resending everything after `persistedSeq` needs.
      database.createObjectStore(CHUNK_STORE, { keyPath: ["sessionId", "seq"] });
    }
  };
  return new ChunkBuffer(await request(open));
}

export class ChunkBuffer {
  private readonly database: IDBDatabase;

  constructor(database: IDBDatabase) {
    this.database = database;
  }

  close(): void {
    this.database.close();
  }

  async putSession(session: BufferedSession): Promise<void> {
    const transaction = this.database.transaction(SESSION_STORE, "readwrite");
    transaction.objectStore(SESSION_STORE).put(session);
    await finish(transaction);
  }

  async getSession(sessionId: string): Promise<BufferedSession | null> {
    const transaction = this.database.transaction(SESSION_STORE, "readonly");
    const found = await request<BufferedSession | undefined>(
      transaction.objectStore(SESSION_STORE).get(sessionId) as IDBRequest<
        BufferedSession | undefined
      >,
    );
    return found ?? null;
  }

  /**
   * Sessions that were never finalized — after a reload or a crash these are the
   * recordings whose audio is still sitting on this device.
   */
  async listUnfinishedSessions(): Promise<BufferedSession[]> {
    const transaction = this.database.transaction(SESSION_STORE, "readonly");
    const all = await request<BufferedSession[]>(
      transaction.objectStore(SESSION_STORE).getAll() as IDBRequest<BufferedSession[]>,
    );
    return all.filter((session) => !session.finalized);
  }

  /** Writes the chunk and moves the session's `lastSeq` forward atomically. */
  async appendChunk(chunk: BufferedChunk): Promise<void> {
    const transaction = this.database.transaction([CHUNK_STORE, SESSION_STORE], "readwrite");
    transaction.objectStore(CHUNK_STORE).put(chunk);
    const sessions = transaction.objectStore(SESSION_STORE);
    const existing = await request<BufferedSession | undefined>(
      sessions.get(chunk.sessionId) as IDBRequest<BufferedSession | undefined>,
    );
    if (existing && chunk.seq > existing.lastSeq) {
      sessions.put({ ...existing, lastSeq: chunk.seq });
    }
    await finish(transaction);
  }

  /** Chunks from `seq` upward, in sequence order. */
  async chunksFrom(sessionId: string, seq: number): Promise<BufferedChunk[]> {
    const transaction = this.database.transaction(CHUNK_STORE, "readonly");
    const range = IDBKeyRange.bound([sessionId, seq], [sessionId, Number.MAX_SAFE_INTEGER]);
    const found = await request<BufferedChunk[]>(
      transaction.objectStore(CHUNK_STORE).getAll(range) as IDBRequest<BufferedChunk[]>,
    );
    return found.sort((left, right) => left.seq - right.seq);
  }

  /**
   * Drops everything the server has confirmed as persisted. Called only from the
   * `chunk.ack` handler — no other path may delete unacknowledged audio.
   */
  async evictThrough(sessionId: string, persistedSeq: number): Promise<void> {
    const transaction = this.database.transaction([CHUNK_STORE, SESSION_STORE], "readwrite");
    transaction
      .objectStore(CHUNK_STORE)
      .delete(IDBKeyRange.bound([sessionId, 0], [sessionId, persistedSeq]));
    const sessions = transaction.objectStore(SESSION_STORE);
    const existing = await request<BufferedSession | undefined>(
      sessions.get(sessionId) as IDBRequest<BufferedSession | undefined>,
    );
    if (existing && persistedSeq > existing.persistedSeq) {
      sessions.put({ ...existing, persistedSeq });
    }
    await finish(transaction);
  }

  /** How much audio is currently held locally and still unacknowledged. */
  async pendingStats(sessionId: string): Promise<PendingStats> {
    const chunks = await this.chunksFrom(sessionId, 0);
    return chunks.reduce<PendingStats>(
      (stats, chunk) => ({
        count: stats.count + 1,
        durationSeconds: stats.durationSeconds + chunk.duration,
        bytes: stats.bytes + chunk.payload.byteLength,
      }),
      { count: 0, durationSeconds: 0, bytes: 0 },
    );
  }

  /** Removes a session and all of its chunks — after finalize, or on discard. */
  async deleteSession(sessionId: string): Promise<void> {
    const transaction = this.database.transaction([CHUNK_STORE, SESSION_STORE], "readwrite");
    transaction
      .objectStore(CHUNK_STORE)
      .delete(IDBKeyRange.bound([sessionId, 0], [sessionId, Number.MAX_SAFE_INTEGER]));
    transaction.objectStore(SESSION_STORE).delete(sessionId);
    await finish(transaction);
  }
}

/**
 * Remaining storage headroom as a fraction, or null when the browser does not
 * report it. Drives the storage-pressure warning during long offline stretches.
 */
export async function storageHeadroom(): Promise<number | null> {
  if (!navigator.storage?.estimate) return null;
  try {
    const { quota, usage } = await navigator.storage.estimate();
    if (typeof quota !== "number" || typeof usage !== "number" || quota <= 0) return null;
    return Math.max(0, 1 - usage / quota);
  } catch {
    return null;
  }
}
