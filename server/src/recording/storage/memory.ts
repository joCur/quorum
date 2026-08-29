import {
  chunkKey,
  manifestKey,
  sessionKey,
  sessionPrefix,
  seqFromChunkKey,
  type KeyScope,
} from "../keys.js";
import type {
  ByteRange,
  RecordingManifest,
  RecordingStorage,
  SessionRecord,
  StoredObject,
} from "../types.js";

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

  async listSessionObjects(scope: KeyScope): Promise<StoredObject[]> {
    const prefix = `${sessionPrefix(scope)}/`;
    return [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, body]) => ({ key, size: body.byteLength }));
  }

  async readObject(key: string, range?: ByteRange): Promise<Uint8Array> {
    const body = this.objects.get(key);
    if (!body) throw new Error(`no object at key "${key}"`);
    return range ? body.slice(range.from, range.to + 1) : body;
  }

  async deleteObjects(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.objects.delete(key);
  }
}

function sessionKeyPrefix(record: SessionRecord): string {
  return sessionKey(record).replace(/session\.json$/, "");
}
