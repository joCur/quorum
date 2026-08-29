import { describe, expect, it } from "vitest";
import { audioLayout, resolveRange, slicesForRange } from "../src/meetings/audio.js";
import { chunkKey, manifestKey, sessionKey } from "../src/recording/keys.js";
import type { StoredObject } from "../src/recording/types.js";

const SCOPE = { tenantId: "tenant-acme", userId: "user-1", sessionId: "session-1" };

/** Three chunks of 10, 20 and 5 bytes, listed out of order and mixed with the metadata objects. */
const OBJECTS: StoredObject[] = [
  { key: chunkKey(SCOPE, 2), size: 5 },
  { key: manifestKey(SCOPE), size: 400 },
  { key: chunkKey(SCOPE, 0), size: 10 },
  { key: sessionKey(SCOPE), size: 300 },
  { key: chunkKey(SCOPE, 1), size: 20 },
];

describe("audio layout", () => {
  it("orders chunks by sequence number and ignores the metadata objects", () => {
    const layout = audioLayout(OBJECTS);
    expect(layout.totalBytes).toBe(35);
    expect(layout.parts).toEqual([
      { key: chunkKey(SCOPE, 0), size: 10, offset: 0 },
      { key: chunkKey(SCOPE, 1), size: 20, offset: 10 },
      { key: chunkKey(SCOPE, 2), size: 5, offset: 30 },
    ]);
  });

  it("reports an empty layout when nothing is stored", () => {
    expect(audioLayout([{ key: sessionKey(SCOPE), size: 300 }])).toEqual({
      parts: [],
      totalBytes: 0,
    });
  });
});

describe("range resolution", () => {
  it("serves the whole stream without a Range header", () => {
    expect(resolveRange(undefined, 35)).toEqual({ kind: "full" });
  });

  it("reads an open-ended range to the last byte", () => {
    expect(resolveRange("bytes=10-", 35)).toEqual({ kind: "partial", range: { from: 10, to: 34 } });
  });

  it("reads a closed range", () => {
    expect(resolveRange("bytes=5-9", 35)).toEqual({ kind: "partial", range: { from: 5, to: 9 } });
  });

  it("clamps a range that runs past the end", () => {
    expect(resolveRange("bytes=30-999", 35)).toEqual({
      kind: "partial",
      range: { from: 30, to: 34 },
    });
  });

  it("reads a suffix range as the last bytes", () => {
    expect(resolveRange("bytes=-5", 35)).toEqual({ kind: "partial", range: { from: 30, to: 34 } });
  });

  it("clamps a suffix range longer than the stream", () => {
    expect(resolveRange("bytes=-999", 35)).toEqual({ kind: "partial", range: { from: 0, to: 34 } });
  });

  it("rejects a start beyond the end", () => {
    expect(resolveRange("bytes=35-40", 35)).toEqual({ kind: "unsatisfiable" });
  });

  it("falls back to the full stream for a syntax it does not understand", () => {
    // RFC 9110 allows ignoring a Range header that cannot be honored, which beats failing a
    // playback request over a multipart range no audio element asks for.
    expect(resolveRange("bytes=0-1,4-5", 35)).toEqual({ kind: "full" });
    expect(resolveRange("items=0-1", 35)).toEqual({ kind: "full" });
  });
});

describe("range slicing", () => {
  const layout = audioLayout(OBJECTS);

  it("takes whole objects when the range covers them completely", () => {
    expect(slicesForRange(layout, { from: 0, to: 34 })).toEqual([
      { key: chunkKey(SCOPE, 0), range: undefined },
      { key: chunkKey(SCOPE, 1), range: undefined },
      { key: chunkKey(SCOPE, 2), range: undefined },
    ]);
  });

  it("slices the first and last object and skips the ones outside the range", () => {
    expect(slicesForRange(layout, { from: 5, to: 31 })).toEqual([
      { key: chunkKey(SCOPE, 0), range: { from: 5, to: 9 } },
      { key: chunkKey(SCOPE, 1), range: undefined },
      { key: chunkKey(SCOPE, 2), range: { from: 0, to: 1 } },
    ]);
  });

  it("reads a range that lives inside a single object", () => {
    expect(slicesForRange(layout, { from: 12, to: 14 })).toEqual([
      { key: chunkKey(SCOPE, 1), range: { from: 2, to: 4 } },
    ]);
  });
});
