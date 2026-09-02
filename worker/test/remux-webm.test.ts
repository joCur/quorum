import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inspectWebm, remuxWebm, RemuxError } from "../src/remux/webm.js";

/**
 * The remuxer (ADR-010).
 *
 * The fixture is a real one: six seconds captured through Chromium's own `MediaRecorder` with a
 * one-second timeslice, its chunks concatenated exactly the way the playback endpoint
 * concatenates the stored objects. Synthetic input can be made to prove anything about a
 * container; only a stream an actual browser wrote proves the thing that matters, which is that
 * the shape this code was written against is the shape that arrives.
 */
const FIXTURE = new Uint8Array(
  readFileSync(fileURLToPath(new URL("./fixtures/incremental-recording.webm", import.meta.url))),
);

/** How many clusters a stream holds, found by scanning for the cluster id. */
function clusterCount(input: Uint8Array): number {
  const found: number[] = [];
  for (let i = 0; i + 1 < input.byteLength; i += 1) {
    // Cluster id, then walk its children looking for SimpleBlocks.
    if (
      input[i] === 0x1f &&
      input[i + 1] === 0x43 &&
      input[i + 2] === 0xb6 &&
      input[i + 3] === 0x75
    ) {
      found.push(i);
    }
  }
  return found.length;
}

describe("the incrementally written stream", () => {
  it("is exactly as unseekable as the ticket says", () => {
    const inspected = inspectWebm(FIXTURE);
    expect(inspected.hasCues).toBe(false);
    expect(inspected.durationSeconds).toBeNull();
  });
});

describe("remuxWebm", () => {
  const result = remuxWebm(FIXTURE);

  it("produces a file that declares a duration and carries a cue index", () => {
    const inspected = inspectWebm(result.bytes);
    expect(inspected.hasCues).toBe(true);
    expect(inspected.durationSeconds).toBeCloseTo(result.durationSeconds, 6);
  });

  it("recovers the recording's real length from the block timestamps", () => {
    // The fixture is six seconds of capture; the last frame lands just short of that.
    expect(result.durationSeconds).toBeGreaterThan(5.5);
    expect(result.durationSeconds).toBeLessThan(6.1);
  });

  it("keeps every cluster, so no audio is merged, split or dropped", () => {
    expect(result.clusterCount).toBe(6);
    expect(clusterCount(result.bytes)).toBe(clusterCount(FIXTURE));
  });

  it("indexes the recording without naming every cluster", () => {
    expect(result.cueCount).toBeGreaterThan(0);
    expect(result.cueCount).toBeLessThanOrEqual(result.clusterCount);
  });

  it("costs a fraction of a percent in storage rather than a second copy", () => {
    const growth = (result.bytes.byteLength - FIXTURE.byteLength) / FIXTURE.byteLength;
    expect(growth).toBeLessThan(0.01);
  });

  it("puts the index in front of the audio, so a player need not read to the end", () => {
    const cuesId = [0x1c, 0x53, 0xbb, 0x6b];
    const clusterId = [0x1f, 0x43, 0xb6, 0x75];
    expect(indexOfBytes(result.bytes, cuesId)).toBeGreaterThan(-1);
    expect(indexOfBytes(result.bytes, cuesId)).toBeLessThan(indexOfBytes(result.bytes, clusterId));
  });

  it("is a repackaging: every audio byte comes across untouched", () => {
    // Every SimpleBlock of the source, in order, has to appear in the output. Comparing the
    // payload rather than the container is what makes "lossless" a tested claim instead of an
    // intention — a re-encode would fail this even if it produced a perfectly valid file.
    const source = Buffer.from(FIXTURE);
    const out = Buffer.from(result.bytes);
    let searchFrom = 0;
    let blocks = 0;
    for (const block of simpleBlocks(FIXTURE)) {
      const needle = source.subarray(block.from, block.to);
      const at = out.indexOf(needle, searchFrom);
      expect(at).toBeGreaterThan(-1);
      searchFrom = at + needle.byteLength;
      blocks += 1;
    }
    expect(blocks).toBeGreaterThan(0);
  });

  it("is idempotent in the only sense that matters: its own output stays seekable", () => {
    const again = remuxWebm(result.bytes);
    expect(inspectWebm(again.bytes).hasCues).toBe(true);
    expect(again.durationSeconds).toBeCloseTo(result.durationSeconds, 6);
    expect(again.clusterCount).toBe(result.clusterCount);
  });
});

describe("remuxWebm on input it cannot use", () => {
  it("refuses a stream that is not EBML at all", () => {
    expect(() => remuxWebm(new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00, 0x01]))).toThrow(
      RemuxError,
    );
  });

  it("refuses an empty stream", () => {
    expect(() => remuxWebm(new Uint8Array(0))).toThrow(RemuxError);
  });

  it("refuses a header with no clusters behind it", () => {
    // Everything up to the first cluster: a valid opening, and nothing to index.
    const firstCluster = indexOfBytes(FIXTURE, [0x1f, 0x43, 0xb6, 0x75]);
    expect(firstCluster).toBeGreaterThan(0);
    expect(() => remuxWebm(FIXTURE.subarray(0, firstCluster))).toThrow(RemuxError);
  });

  it("salvages a recording whose last chunk never finished arriving", () => {
    // A crash between two chunk writes leaves a stream that ends mid-element. The audio before
    // the cut is intact and has to stay playable — dropping the whole recording over a truncated
    // final second would be the worst possible reading of the crash-safety promise.
    const truncated = FIXTURE.subarray(0, FIXTURE.byteLength - 700);
    const result = remuxWebm(truncated);
    expect(result.durationSeconds).toBeGreaterThan(4);
    expect(inspectWebm(result.bytes).hasCues).toBe(true);
  });
});

describe("inspectWebm", () => {
  it("says nothing is there when handed something that is not a WebM file", () => {
    expect(inspectWebm(new Uint8Array([1, 2, 3, 4]))).toEqual({
      hasCues: false,
      durationSeconds: null,
    });
  });

  it("reads the file rather than recomputing it: a truncated artifact has no duration", () => {
    const remuxed = remuxWebm(FIXTURE);
    expect(inspectWebm(remuxed.bytes.subarray(0, 20)).durationSeconds).toBeNull();
  });
});

function indexOfBytes(haystack: Uint8Array, needle: readonly number[]): number {
  return Buffer.from(haystack).indexOf(Buffer.from(needle));
}

/** Byte ranges of the SimpleBlock payloads in a live-written stream. */
function* simpleBlocks(input: Uint8Array): Generator<{ from: number; to: number }> {
  let pos = 0;
  while (pos + 1 < input.byteLength) {
    if (input[pos] !== 0xa3) {
      pos += 1;
      continue;
    }
    const sizeByte = input[pos + 1] as number;
    let width = 1;
    for (let mask = 0x80; mask > 0 && (sizeByte & mask) === 0; mask >>= 1) width += 1;
    if (width > 8 || pos + 1 + width > input.byteLength) break;
    let size = sizeByte & (0xff >> width);
    for (let i = 1; i < width; i += 1) size = size * 256 + (input[pos + 1 + i] as number);
    const from = pos;
    const to = pos + 1 + width + size;
    if (to > input.byteLength) break;
    yield { from, to };
    pos = to;
  }
}
