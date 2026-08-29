import { chunkKey, manifestKey, sessionKey, seqFromChunkKey } from "../keys.js";
import type { RecordingManifest, RecordingStorage, SessionRecord } from "../types.js";

/**
 * In-memory storage adapter. Used by the unit tests and as the reference for the
 * behavior the S3 adapter must provide (idempotent writes, key layout).
 */
export class InMemoryRecordingStorage implements RecordingStorage {
  readonly objects = new Map<string, Uint8Array>();
  /** Set to make the next write fail — used to test "ack only after a write". */
  failNextWrite = false;

  private write(key: string, body: Uint8Array): void {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("simulated storage failure");
    }
    this.objects.set(key, body);
  }

  async putSession(record: SessionRecord): Promise<void> {
    this.write(sessionKey(record), new TextEncoder().encode(JSON.stringify(record)));
  }

  async getSession(
    tenantId: string,
    userId: string,
    sessionId: string,
  ): Promise<SessionRecord | null> {
    const body = this.objects.get(sessionKey({ tenantId, userId, sessionId }));
    if (!body) return null;
    return JSON.parse(new TextDecoder().decode(body)) as SessionRecord;
  }

  async putChunk(record: SessionRecord, seq: number, payload: Uint8Array): Promise<void> {
    this.write(chunkKey(record, seq), Uint8Array.from(payload));
  }

  async listChunkSeqs(record: SessionRecord): Promise<number[]> {
    const seqs: number[] = [];
    for (const key of this.objects.keys()) {
      if (!key.startsWith(`${sessionKeyPrefix(record)}chunks/`)) continue;
      const seq = seqFromChunkKey(key);
      if (seq !== null) seqs.push(seq);
    }
    return seqs.sort((a, b) => a - b);
  }

  async putManifest(record: SessionRecord, manifest: RecordingManifest): Promise<void> {
    this.write(manifestKey(record), new TextEncoder().encode(JSON.stringify(manifest)));
  }
}

function sessionKeyPrefix(record: SessionRecord): string {
  return sessionKey(record).replace(/session\.json$/, "");
}
