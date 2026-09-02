import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inspectWebm, remuxWebm, RemuxError, scanClusterMarks } from "../src/remux/webm.js";

/**
 * The fixture is a real one: six seconds captured through Chromium's own `MediaRecorder` with a
 * one-second timeslice, its chunks concatenated exactly the way the playback endpoint
 * concatenates the stored objects. Synthetic input can be made to prove anything about a
 * container; only a stream an actual browser wrote proves the thing that matters, which is that
 * the shape this code was written against is the shape that arrives.
 */
const FIXTURE = new Uint8Array(
  readFileSync(fileURLToPath(new URL("./fixtures/incremental-recording.webm", import.meta.url))),
);

function clusterCount(input: Uint8Array): number {
  const found: number[] = [];
  for (let i = 0; i + 1 < input.byteLength; i += 1) {
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

  it("reads back holding every cluster it was made of", () => {
    // The integrity check the job's "verify, then delete" order rests on: a parse that lost a
    // stretch of the recording would still produce a file that opens cleanly.
    expect(inspectWebm(result.bytes).clusterCount).toBe(result.clusterCount);
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

  it("refuses a stream that is two recordings concatenated", () => {
    // A recorder restarted mid-session — a tab that crashed and came back — appends a fresh EBML
    // header to the same object rather than continuing the stream. Everything after that header
    // is real audio that this remuxer would swallow as cluster payload, and the chunks would
    // then be deleted. Refusing is the only answer that does not lose half a meeting.
    const doubled = new Uint8Array(FIXTURE.byteLength * 2);
    doubled.set(FIXTURE, 0);
    doubled.set(FIXTURE, FIXTURE.byteLength);

    expect(() => remuxWebm(doubled)).toThrow(/second EBML header/);
  });

  it("refuses a stream it could not read to the end", () => {
    // One bad byte partway through used to end the walk quietly, and the result was a two-hour
    // recording repackaged down to whatever came before the damage — followed by the deletion of
    // everything that did not make it.
    const damaged = Uint8Array.from(FIXTURE);
    const secondCluster = Buffer.from(damaged).indexOf(
      Buffer.from([0x1f, 0x43, 0xb6, 0x75]),
      indexOfBytes(damaged, [0x1f, 0x43, 0xb6, 0x75]) + 4,
    );
    expect(secondCluster).toBeGreaterThan(0);
    // Past the cluster id and its eight-byte unknown-size marker sits the Timestamp, the first
    // child. A zero there is not an element id, and the walk cannot go on.
    damaged[secondCluster + 12] = 0x00;

    expect(() => remuxWebm(damaged)).toThrow(RemuxError);
    // And specifically for the right reason: bytes it could not account for, not a shrug.
    expect(() => remuxWebm(damaged)).toThrow(/unaccounted for/);
  });

  it("refuses a stream carrying anything but audio", () => {
    // TrackType 1 is video. Nothing this product records produces one, so a stream that has one
    // is a stream this remuxer was never written against — and large enough that buffering it
    // whole would matter.
    const withVideo = Uint8Array.from(FIXTURE);
    const trackType = indexOfBytes(withVideo, [0x83, 0x81, 0x02]);
    expect(trackType).toBeGreaterThan(0);
    withVideo[trackType + 2] = 0x01;

    expect(() => remuxWebm(withVideo)).toThrow(/non-audio track/);
  });

  it("counts the source's clusters without help from the parser", () => {
    // The number the stored artifact is held to. It has to come from somewhere the parser had no
    // hand in, or a parser that dropped clusters would simply report the smaller figure and the
    // verification would agree with it.
    const result = remuxWebm(FIXTURE);
    expect(result.sourceClusterMarks).toBe(6);
    expect(scanClusterMarks(result.bytes)).toBe(result.sourceClusterMarks);
  });

  it("salvages a recording that ends in a byte too short to be anything", () => {
    // A `MediaRecorder` can deliver a last blob of a byte or two, and a stream can stop partway
    // through an element header rather than partway through its body. Neither can be a dropped
    // cluster — a cluster's header alone is twelve bytes — so a tail shorter than any element is
    // the same cut-off recording as a truncated body, and the audio before it is all there.
    const withTail = new Uint8Array(FIXTURE.byteLength + 1);
    withTail.set(FIXTURE, 0);
    withTail[FIXTURE.byteLength] = 0xa3;

    const result = remuxWebm(withTail);
    expect(result.clusterCount).toBe(6);
    expect(inspectWebm(result.bytes).hasCues).toBe(true);
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
      clusterCount: 0,
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
