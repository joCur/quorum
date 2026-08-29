import { describe, expect, it } from "vitest";
import { JobError } from "../src/errors.js";
import { chunkKey, manifestKey, sessionKey } from "../src/storage/keys.js";
import {
  audioFileDescriptor,
  concatenateChunks,
  resolveChunkKeys,
} from "../src/storage/manifest.js";
import { S3AudioSource } from "../src/storage/audio-source.js";
import { SCOPE, encodeJson, fakeS3Client, manifest } from "./helpers.js";

describe("chunk manifest", () => {
  it("returns the manifest's own chunk keys when they follow the layout", () => {
    const value = manifest({ chunkCount: 3, persistedSeq: 2 });
    expect(resolveChunkKeys(value, SCOPE)).toEqual([
      chunkKey(SCOPE, 0),
      chunkKey(SCOPE, 1),
      chunkKey(SCOPE, 2),
    ]);
  });

  it("reconstructs the keys when the manifest lists none", () => {
    const value = manifest({ chunkCount: 2, persistedSeq: 1, chunkKeys: [] });
    expect(resolveChunkKeys(value, SCOPE)).toEqual([chunkKey(SCOPE, 0), chunkKey(SCOPE, 1)]);
  });

  it("uses zero-padded sequence numbers so lexicographic order is numeric order", () => {
    const keys = resolveChunkKeys(manifest({ chunkCount: 12, persistedSeq: 11 }), SCOPE);
    expect([...keys].sort()).toEqual(keys);
    expect(keys[9]).toContain("/chunks/0000000009.bin");
  });

  it("refuses a manifest whose chunk count contradicts persistedSeq", () => {
    const value = manifest({ chunkCount: 5, persistedSeq: 2, chunkKeys: [] });
    expect(() => resolveChunkKeys(value, SCOPE)).toThrow(JobError);
  });

  it("refuses a manifest whose keys do not follow the storage layout", () => {
    const value = manifest({ chunkCount: 2, persistedSeq: 1 });
    value.chunkKeys[1] = "tenants/other/chunks/0000000001.bin";
    expect(() => resolveChunkKeys(value, SCOPE)).toThrow(/does not follow the expected layout/);
  });

  it("refuses a session that was finalized without a chunk", () => {
    const value = manifest({ chunkCount: 0, persistedSeq: -1, chunkKeys: [] });
    expect(() => resolveChunkKeys(value, SCOPE)).toThrow(/without a single chunk/);
  });
});

describe("chunk assembly", () => {
  it("concatenates chunks in order", () => {
    const assembled = concatenateChunks([
      new Uint8Array([1, 2]),
      new Uint8Array([3]),
      new Uint8Array([4, 5, 6]),
    ]);
    expect([...assembled]).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("rejects an assembly that produces no bytes", () => {
    expect(() => concatenateChunks([new Uint8Array(0)])).toThrow(/assembled audio is empty/);
  });
});

describe("audio file descriptor", () => {
  it.each([
    ["webm", "audio/webm"],
    ["ogg", "audio/ogg"],
    ["mp4", "audio/mp4"],
  ])("maps the %s container", (container, contentType) => {
    expect(audioFileDescriptor(container).contentType).toBe(contentType);
  });

  it("rejects an unknown container", () => {
    expect(() => audioFileDescriptor("wav")).toThrow(/unsupported audio container/);
  });
});

describe("S3AudioSource", () => {
  function source(objects: Map<string, Uint8Array>): S3AudioSource {
    return new S3AudioSource(
      {
        endpoint: "http://minio:9000",
        region: "us-east-1",
        bucket: "recordings",
        accessKeyId: "key",
        secretAccessKey: "secret",
      },
      fakeS3Client(objects),
    );
  }

  it("loads the manifest, the session and the assembled audio", async () => {
    const value = manifest({ chunkCount: 3, persistedSeq: 2 });
    const objects = new Map<string, Uint8Array>([
      [manifestKey(SCOPE), encodeJson(value)],
      [
        sessionKey(SCOPE),
        encodeJson({
          sessionId: SCOPE.sessionId,
          meetingId: value.meetingId,
          tenantId: SCOPE.tenantId,
          userId: SCOPE.userId,
          meetingTitle: null,
          audioFormat: value.audioFormat,
          createdAt: "2026-08-29T10:00:00.000Z",
          marks: [],
        }),
      ],
      [chunkKey(SCOPE, 0), new Uint8Array([0x1a, 0x45])],
      [chunkKey(SCOPE, 1), new Uint8Array([0xdf])],
      [chunkKey(SCOPE, 2), new Uint8Array([0xa3, 0x99])],
    ]);
    const audio = source(objects);

    const loaded = await audio.loadManifest(SCOPE);
    expect(loaded.chunkCount).toBe(3);
    expect((await audio.loadSession(SCOPE))?.createdAt).toBe("2026-08-29T10:00:00.000Z");
    expect([...(await audio.loadAudio(loaded, SCOPE))]).toEqual([0x1a, 0x45, 0xdf, 0xa3, 0x99]);
  });

  it("fails without retry when the session was never finalized", async () => {
    await expect(source(new Map()).loadManifest(SCOPE)).rejects.toMatchObject({
      code: "MANIFEST_NOT_FOUND",
      retryable: false,
    });
  });

  it("fails when a chunk listed in the manifest is missing", async () => {
    const value = manifest({ chunkCount: 2, persistedSeq: 1 });
    const objects = new Map<string, Uint8Array>([
      [manifestKey(SCOPE), encodeJson(value)],
      [chunkKey(SCOPE, 0), new Uint8Array([1])],
    ]);
    await expect(source(objects).loadAudio(value, SCOPE)).rejects.toMatchObject({
      code: "AUDIO_FETCH_FAILED",
    });
  });

  it("rejects a manifest that is not valid JSON", async () => {
    const objects = new Map<string, Uint8Array>([
      [manifestKey(SCOPE), new TextEncoder().encode("{not json")],
    ]);
    await expect(source(objects).loadManifest(SCOPE)).rejects.toMatchObject({
      code: "AUDIO_EMPTY",
    });
  });
});
