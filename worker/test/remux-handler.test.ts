import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";
import { JobSchema } from "@quorum/shared";
import { runRemuxJob, type RemuxHandlerDependencies } from "../src/remux/handler.js";
import { remuxJobIdFor } from "../src/ids.js";
import type { RemuxJobPayload } from "../src/payload.js";
import type { AudioSource, RemuxStorage } from "../src/storage/audio-source.js";
import {
  audioKey,
  chunkKey,
  manifestKey,
  sessionKey,
  stagingAudioKey,
} from "../src/storage/keys.js";
import { RecordingManifestSchema, type RecordingManifest } from "../src/storage/manifest.js";
import { inspectWebm } from "../src/remux/webm.js";
import { JobError } from "../src/errors.js";
import { MEETING_ID, SCOPE, capturingLogger, silentLogger } from "./helpers.js";

const RECORDING = new Uint8Array(
  readFileSync(fileURLToPath(new URL("./fixtures/incremental-recording.webm", import.meta.url))),
);

/** The fixture, cut into chunk-sized pieces the way the recording endpoint stored it. */
function chunksOf(recording: Uint8Array, count: number): Uint8Array[] {
  const size = Math.ceil(recording.byteLength / count);
  return Array.from({ length: count }, (_value, index) =>
    recording.subarray(index * size, Math.min((index + 1) * size, recording.byteLength)),
  );
}

const CHUNK_COUNT = 4;

/**
 * Object storage as a map, standing in for MinIO.
 *
 * It is the same store on both ports on purpose: the job reads through `AudioSource` and writes
 * through `RemuxStorage`, and the questions this suite asks — what is left after a failure, what
 * playback would find — are questions about the one set of objects both of them see.
 */
class FakeStore implements AudioSource, RemuxStorage {
  readonly objects = new Map<string, Uint8Array>();
  /** Keys whose next write must fail, to stage a crash at a chosen point. */
  failWriteOf: string | null = null;
  /** Bytes to hand back for a read-back check instead of what was written. */
  corruptReadOf: string | null = null;
  readonly copies: Array<{ from: string; to: string }> = [];

  constructor(manifest: RecordingManifest, chunks: readonly Uint8Array[]) {
    this.objects.set(manifestKey(SCOPE), encode(manifest));
    chunks.forEach((chunk, seq) => this.objects.set(chunkKey(SCOPE, seq), chunk));
    this.objects.set(sessionKey(SCOPE), encode({ sessionId: SCOPE.sessionId }));
  }

  get keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  async loadManifest(): Promise<RecordingManifest> {
    const bytes = this.objects.get(manifestKey(SCOPE));
    if (!bytes) throw new JobError("MANIFEST_NOT_FOUND", "no manifest", { retryable: false });
    return RecordingManifestSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
  }

  async loadSession(): Promise<null> {
    return null;
  }

  async loadAudio(manifest: RecordingManifest): Promise<Uint8Array> {
    if (manifest.audioKey !== null) {
      const stored = this.objects.get(manifest.audioKey);
      if (!stored) {
        throw new JobError("AUDIO_FETCH_FAILED", "artifact is gone", { retryable: true });
      }
      return stored;
    }
    const parts = manifest.chunkKeys.map((key) => this.objects.get(key));
    if (parts.some((part) => part === undefined)) {
      throw new JobError("AUDIO_FETCH_FAILED", "chunk is gone", { retryable: false });
    }
    return concat(parts as Uint8Array[]);
  }

  async readObject(key: string): Promise<Uint8Array | null> {
    if (this.corruptReadOf === key) return new Uint8Array(3);
    return this.objects.get(key) ?? null;
  }

  async objectSize(key: string): Promise<number | null> {
    return this.objects.get(key)?.byteLength ?? null;
  }

  async writeObject(key: string, body: Uint8Array): Promise<void> {
    if (this.failWriteOf === key) throw new Error(`simulated failure writing "${key}"`);
    this.objects.set(key, body);
  }

  async copyObject(fromKey: string, toKey: string): Promise<void> {
    if (this.failWriteOf === toKey) throw new Error(`simulated failure copying to "${toKey}"`);
    const body = this.objects.get(fromKey);
    if (!body) throw new Error(`nothing at "${fromKey}"`);
    this.copies.push({ from: fromKey, to: toKey });
    this.objects.set(toKey, body);
  }

  async deleteObjects(keys: readonly string[]): Promise<void> {
    for (const key of keys) this.objects.delete(key);
  }

  async writeManifest(_scope: unknown, manifest: RecordingManifest): Promise<void> {
    if (this.failWriteOf === manifestKey(SCOPE)) throw new Error("simulated manifest failure");
    this.objects.set(manifestKey(SCOPE), encode(manifest));
  }
}

function baseManifest(overrides: Partial<RecordingManifest> = {}): RecordingManifest {
  return RecordingManifestSchema.parse({
    sessionId: SCOPE.sessionId,
    meetingId: MEETING_ID,
    tenantId: SCOPE.tenantId,
    userId: SCOPE.userId,
    audioFormat: { codec: "opus", container: "webm", sampleRate: 48_000, channels: 1 },
    chunkCount: CHUNK_COUNT,
    persistedSeq: CHUNK_COUNT - 1,
    chunkKeys: Array.from({ length: CHUNK_COUNT }, (_value, seq) => chunkKey(SCOPE, seq)),
    audioKey: null,
    durationSeconds: null,
    marks: [],
    finalizedAt: "2026-08-29T10:30:00.000Z",
    ...overrides,
  });
}

function payload(overrides: Partial<RemuxJobPayload> = {}): RemuxJobPayload {
  return {
    job: JobSchema.parse({
      id: remuxJobIdFor(SCOPE.sessionId),
      meetingId: MEETING_ID,
      type: "remux",
      status: "queued",
      createdAt: "2026-08-29T10:31:00.000Z",
    }),
    ...SCOPE,
    expectedDurationSeconds: 5.9,
    ...overrides,
  };
}

function deps(
  store: FakeStore,
  options: { meetingExists?: boolean; logger?: RemuxHandlerDependencies["logger"] } = {},
): RemuxHandlerDependencies {
  return {
    audio: store,
    storage: store,
    repository: { meetingExists: async () => options.meetingExists ?? true },
    logger: options.logger ?? silentLogger,
  };
}

describe("the remux job", () => {
  let store: FakeStore;

  beforeEach(() => {
    store = new FakeStore(baseManifest(), chunksOf(RECORDING, CHUNK_COUNT));
  });

  it("replaces the chunk objects with one seekable file", async () => {
    const outcome = await runRemuxJob(payload(), 0, deps(store));

    expect(outcome.chunksDeleted).toBe(CHUNK_COUNT);
    expect(outcome.skipped).toBeUndefined();

    const artifact = store.objects.get(audioKey(SCOPE));
    expect(artifact).toBeDefined();
    expect(inspectWebm(artifact as Uint8Array).hasCues).toBe(true);

    // The single-copy promise of ADR-010, asserted where it is kept: nothing under the session
    // prefix is a chunk any more, and the staged copy is gone too.
    expect(store.keys.filter((key) => key.includes("/chunks/"))).toEqual([]);
    expect(store.objects.has(stagingAudioKey(SCOPE))).toBe(false);
  });

  it("does not grow what the recording costs to store", async () => {
    const outcome = await runRemuxJob(payload(), 0, deps(store));
    const growth =
      ((outcome.remuxedBytes as number) - (outcome.sourceBytes as number)) /
      (outcome.sourceBytes as number);
    expect(growth).toBeLessThan(0.01);
  });

  it("points the manifest at the artifact and records how long it is", async () => {
    await runRemuxJob(payload(), 0, deps(store));
    const manifest = await store.loadManifest();
    expect(manifest.audioKey).toBe(audioKey(SCOPE));
    expect(manifest.durationSeconds).toBeGreaterThan(5);
    // The chunk list stays as written. It is the record of what the recorder delivered, and the
    // artifact is what replaced it — rewriting history would lose the first fact to state the
    // second.
    expect(manifest.chunkKeys).toHaveLength(CHUNK_COUNT);
  });

  it("names the artifact only after reading it back", async () => {
    await runRemuxJob(payload(), 0, deps(store));
    // The bytes that got the final name are the bytes that passed the check: a server-side copy
    // of the staged object, not a second write of what was in memory.
    expect(store.copies).toEqual([{ from: stagingAudioKey(SCOPE), to: audioKey(SCOPE) }]);
  });

  it("leaves the recording exactly as it was when the read-back fails", async () => {
    store.corruptReadOf = stagingAudioKey(SCOPE);
    const before = store.keys.filter((key) => key.includes("/chunks/"));

    await expect(runRemuxJob(payload(), 0, deps(store))).rejects.toMatchObject({
      code: "REMUX_VERIFICATION_FAILED",
    });

    expect(store.keys.filter((key) => key.includes("/chunks/"))).toEqual(before);
    expect(store.objects.has(audioKey(SCOPE))).toBe(false);
    expect((await store.loadManifest()).audioKey).toBeNull();
  });

  it("leaves the recording exactly as it was when the artifact cannot be written", async () => {
    store.failWriteOf = stagingAudioKey(SCOPE);

    await expect(runRemuxJob(payload(), 0, deps(store))).rejects.toBeInstanceOf(Error);

    expect(store.keys.filter((key) => key.includes("/chunks/"))).toHaveLength(CHUNK_COUNT);
    expect(store.objects.has(audioKey(SCOPE))).toBe(false);
  });

  it("refuses to delete the chunks when the duration is nothing like the transcript's", async () => {
    // The one check that can catch a parse which quietly lost half a recording: the byte counts
    // would look plausible, the duration would not.
    await expect(
      runRemuxJob(payload({ expectedDurationSeconds: 3600 }), 0, deps(store)),
    ).rejects.toMatchObject({ code: "REMUX_VERIFICATION_FAILED" });

    expect(store.keys.filter((key) => key.includes("/chunks/"))).toHaveLength(CHUNK_COUNT);
  });

  it("still runs when the transcription reported no duration at all", async () => {
    const outcome = await runRemuxJob(payload({ expectedDurationSeconds: null }), 0, deps(store));
    expect(outcome.chunksDeleted).toBe(CHUNK_COUNT);
  });

  it("fails without touching anything when the container is not one it can read", async () => {
    const garbage = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x84, 0, 0, 0, 0]);
    store = new FakeStore(
      baseManifest({ chunkCount: 1, persistedSeq: 0, chunkKeys: [chunkKey(SCOPE, 0)] }),
      [garbage],
    );

    await expect(runRemuxJob(payload(), 0, deps(store))).rejects.toMatchObject({
      code: "REMUX_FAILED",
      retryable: false,
    });
    expect(store.objects.has(chunkKey(SCOPE, 0))).toBe(true);
  });
});

describe("the remux job on a recording it should leave alone", () => {
  it("is a no-op on a recording that has already been repackaged", async () => {
    const artifact = new Uint8Array([1, 2, 3]);
    const store = new FakeStore(baseManifest({ audioKey: audioKey(SCOPE) }), []);
    store.objects.set(audioKey(SCOPE), artifact);

    const outcome = await runRemuxJob(payload(), 0, deps(store));

    // This is the path a user's retry of a transcription takes, and it must cost nothing and
    // change nothing.
    expect(outcome.skipped).toBe("already-remuxed");
    expect(store.objects.get(audioKey(SCOPE))).toBe(artifact);
    expect(store.copies).toEqual([]);
  });

  it("leaves a container it does not repackage in the shape it plays in", async () => {
    const store = new FakeStore(
      baseManifest({
        audioFormat: { codec: "aac", container: "mp4", sampleRate: 48_000, channels: 1 },
      }),
      chunksOf(RECORDING, CHUNK_COUNT),
    );

    const outcome = await runRemuxJob(payload(), 0, deps(store));

    expect(outcome.skipped).toBe("unsupported-container");
    expect(store.keys.filter((key) => key.includes("/chunks/"))).toHaveLength(CHUNK_COUNT);
  });

  it("abandons the run and cleans up when the meeting was deleted mid-job", async () => {
    const store = new FakeStore(baseManifest(), chunksOf(RECORDING, CHUNK_COUNT));
    const { logger, events } = capturingLogger();

    const outcome = await runRemuxJob(payload(), 0, deps(store, { meetingExists: false, logger }));

    // Nothing may come back from the dead: no artifact, no manifest pointing at one, and not
    // even the staged object the job had already written.
    expect(outcome.abandoned).toBe("meeting-deleted");
    expect(store.objects.has(audioKey(SCOPE))).toBe(false);
    expect(store.objects.has(stagingAudioKey(SCOPE))).toBe(false);
    expect(events.some((event) => event.event === "job.abandoned")).toBe(true);
  });
});

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}
