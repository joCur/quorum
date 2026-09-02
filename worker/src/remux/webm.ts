/**
 * Lossless WebM remuxer: turns the live stream a `MediaRecorder` produced into a
 * seekable file (ADR-010).
 *
 * WHAT IS WRONG WITH THE INPUT. A live writer cannot know byte offsets it has not
 * written yet, so it declares none: the Segment has unknown size, every Cluster has
 * unknown size, the Info element carries no Duration, and there is no Cues element.
 * A player handed that stream reports a duration of `Infinity` and has no map from a
 * point in time to a byte offset.
 *
 * TWO INVARIANTS HOLD IT TOGETHER. Every Cluster's children are moved across verbatim, so not
 * one Opus packet is touched and "lossless" is a property of the code rather than an intention.
 * And the Cues index is placed *before* the clusters, so a player learns the whole map from the
 * first few kilobytes instead of reading to the end of a long recording over the network.
 *
 * WHY IT IS WRITTEN HERE RATHER THAN SHELLED OUT TO A MUXER. The operation is a few
 * hundred lines of well-specified byte pushing against a container we produce
 * ourselves, and keeping it in process is what keeps the pipeline free of a native
 * binary that every image, every developer machine and the end-to-end runner would
 * otherwise have to carry.
 */

/** Element ids, as they appear on the wire (marker bits included). */
const ID = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  seekHead: 0x114d9b74,
  seek: 0x4dbb,
  seekId: 0x53ab,
  seekPosition: 0x53ac,
  info: 0x1549a966,
  timestampScale: 0x2ad7b1,
  duration: 0x4489,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  trackType: 0x83,
  cues: 0x1c53bb6b,
  cuePoint: 0xbb,
  cueTime: 0xb3,
  cueTrackPositions: 0xb7,
  cueTrack: 0xf7,
  cueClusterPosition: 0xf1,
  cluster: 0x1f43b675,
  timestamp: 0xe7,
  simpleBlock: 0xa3,
  blockGroup: 0xa0,
  void: 0xec,
} as const;

/**
 * Ids that may follow an unknown-size Cluster at the level above it.
 *
 * A Cluster whose size is unknown ends where the next element of its parent begins,
 * so this set is what tells the parser it has walked out of one — the Matroska spec's
 * own rule, and the only way to find cluster boundaries in a live stream.
 */
const SEGMENT_LEVEL_IDS = new Set<number>([
  ID.cluster,
  // The two levels *above* a cluster end one just as surely as a sibling does, and leaving them
  // out is how a second recording appended to the same object got eaten as cluster payload: the
  // walk read the new EBML header as a child element and carried on through the audio behind it.
  ID.ebml,
  ID.segment,
  ID.cues,
  ID.info,
  ID.tracks,
  ID.seekHead,
  0x1254c367, // Tags
  0x1941a469, // Attachments
  0x1043a770, // Chapters
]);

/** Nanoseconds per timestamp unit when the Info element does not say otherwise. */
const DEFAULT_TIMESTAMP_SCALE = 1_000_000;

/**
 * How much audio one cue point covers.
 *
 * Cues do not have to name every cluster, and naming all of them would spend about
 * 13 kB per hour to save a player at most a second of forward decoding. One entry
 * every few seconds costs a twelfth of that and lands the player close enough that
 * the decode to the exact target is imperceptible.
 */
const CUE_INTERVAL_MS = 5_000;

export class RemuxError extends Error {}

export interface RemuxResult {
  bytes: Uint8Array;
  /** Playing time of the recording, from the block timestamps. */
  durationSeconds: number;
  /** Clusters carried over — unchanged, since none are merged or split. */
  clusterCount: number;
  /**
   * Clusters counted in the *source* by a scan that shares no code with the parser.
   *
   * This is the number the stored artifact is held to. Comparing the artifact against the
   * parser's own count would be the parser confirming itself: one that dropped clusters reports
   * the reduced figure and the check passes.
   */
  sourceClusterMarks: number;
  cueCount: number;
}

/** Every read is bounds-checked against `end`, so a truncated buffer cannot walk off it. */
class Reader {
  readonly buf: Uint8Array;
  pos: number;
  readonly end: number;

  constructor(buf: Uint8Array, pos: number, end: number) {
    this.buf = buf;
    this.pos = pos;
    this.end = end;
  }

  get done(): boolean {
    return this.pos >= this.end;
  }

  /** Reads an element id, which keeps its marker bits — they are part of the id. */
  readId(): number | null {
    const first = this.buf[this.pos];
    if (first === undefined || first === 0) return null;
    let width = 1;
    for (let mask = 0x80; mask > 0 && (first & mask) === 0; mask >>= 1) width += 1;
    if (width > 4 || this.pos + width > this.end) return null;
    let value = 0;
    for (let i = 0; i < width; i += 1) value = value * 256 + (this.buf[this.pos + i] as number);
    this.pos += width;
    return value;
  }

  /** Reads a data size, whose marker bit is stripped. `null` means "unknown size". */
  readSize(): { value: number | null } | null {
    const first = this.buf[this.pos];
    if (first === undefined || first === 0) return null;
    let width = 1;
    for (let mask = 0x80; mask > 0 && (first & mask) === 0; mask >>= 1) width += 1;
    if (width > 8 || this.pos + width > this.end) return null;
    let value = first & (0xff >> width);
    let unknown = value === 0xff >> width;
    for (let i = 1; i < width; i += 1) {
      const byte = this.buf[this.pos + i] as number;
      value = value * 256 + byte;
      if (byte !== 0xff) unknown = false;
    }
    this.pos += width;
    if (unknown) return { value: null };
    // An eight-byte size can name more bytes than a double can count. Past that point the
    // arithmetic silently rounds, so a length that large is refused rather than approximated —
    // no recording is anywhere near it, and a value that is means the bytes are not a size.
    if (!Number.isSafeInteger(value)) return null;
    return { value };
  }
}

function readUint(buf: Uint8Array, from: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i += 1) value = value * 256 + (buf[from + i] as number);
  return value;
}

/** Byte width the smallest legal size VINT needs for `value`. */
function sizeWidth(value: number): number {
  for (let width = 1; width <= 8; width += 1) {
    // The all-ones pattern of a given width means "unknown", so it cannot encode a length.
    if (value < 2 ** (7 * width) - 1) return width;
  }
  throw new RemuxError(`element of ${value} bytes is too large to encode`);
}

class Writer {
  private parts: Uint8Array[] = [];
  private length = 0;

  get bytes(): number {
    return this.length;
  }

  raw(chunk: Uint8Array): void {
    this.parts.push(chunk);
    this.length += chunk.byteLength;
  }

  id(value: number): void {
    const width = value > 0xffffff ? 4 : value > 0xffff ? 3 : value > 0xff ? 2 : 1;
    const out = new Uint8Array(width);
    for (let i = 0; i < width; i += 1) out[width - 1 - i] = (value >>> (8 * i)) & 0xff;
    this.raw(out);
  }

  /** A data size. `width` forces a wider encoding than the value needs. */
  size(value: number, width = sizeWidth(value)): void {
    const out = new Uint8Array(width);
    let rest = value;
    for (let i = width - 1; i >= 0; i -= 1) {
      out[i] = rest % 256;
      rest = Math.floor(rest / 256);
    }
    out[0] = (out[0] as number) | (0x80 >> (width - 1));
    this.raw(out);
  }

  concat(): Uint8Array {
    const out = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }
}

/** An unsigned integer element written at a fixed width, so its size is predictable. */
function uintElement(id: number, value: number, width: number): Uint8Array {
  const writer = new Writer();
  writer.id(id);
  writer.size(width);
  const out = new Uint8Array(width);
  let rest = value;
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = rest % 256;
    rest = Math.floor(rest / 256);
  }
  writer.raw(out);
  return writer.concat();
}

function floatElement(id: number, value: number): Uint8Array {
  const writer = new Writer();
  writer.id(id);
  writer.size(8);
  const out = new Uint8Array(8);
  new DataView(out.buffer).setFloat64(0, value, false);
  writer.raw(out);
  return writer.concat();
}

interface ParsedCluster {
  timestamp: number;
  childrenFrom: number;
  childrenTo: number;
}

interface Parsed {
  ebmlHeader: Uint8Array;
  infoChildren: Uint8Array[];
  tracks: Uint8Array;
  tracksSummary: TrackSummary;
  timestampScale: number;
  clusters: ParsedCluster[];
  /** End of the last block, in timestamp units. */
  durationTicks: number;
  /** How the walk ended — the check that stands between a partial read and a deletion. */
  tail: Tail;
}

function parse(input: Uint8Array): Parsed {
  const reader = new Reader(input, 0, input.byteLength);

  const ebmlId = reader.readId();
  const ebmlSize = reader.readSize();
  if (ebmlId !== ID.ebml || !ebmlSize || ebmlSize.value === null) {
    throw new RemuxError("the stream does not begin with an EBML header");
  }
  const ebmlHeader = input.subarray(0, reader.pos + ebmlSize.value);
  reader.pos += ebmlSize.value;

  const segmentId = reader.readId();
  const segmentSize = reader.readSize();
  if (segmentId !== ID.segment || !segmentSize) {
    throw new RemuxError("no Segment follows the EBML header");
  }
  const segmentEnd =
    segmentSize.value === null
      ? input.byteLength
      : Math.min(reader.pos + segmentSize.value, input.byteLength);

  let infoChildren: Uint8Array[] | null = null;
  let tracks: Uint8Array | null = null;
  let tracksSummary: TrackSummary = { number: 1, types: [] };
  let timestampScale = DEFAULT_TIMESTAMP_SCALE;
  const clusters: ParsedCluster[] = [];
  let durationTicks = 0;
  /** Where the walk gave up, if it did. Left at the start of the element it could not read. */
  let stoppedAt: number | null = null;

  while (reader.pos < segmentEnd) {
    const start = reader.pos;
    const id = reader.readId();
    if (id === null) {
      stoppedAt = start;
      break;
    }
    // A second EBML header inside the Segment is not an element of this recording; it is where
    // the next one begins. Stopping on the id rather than skipping the header is what lets the
    // tail be recognised for what it is instead of being reported as damage further along.
    if (id === ID.ebml) {
      stoppedAt = start;
      break;
    }
    const size = reader.readSize();
    if (size === null) {
      stoppedAt = start;
      break;
    }
    const bodyFrom = reader.pos;

    if (id === ID.cluster) {
      const cluster = parseCluster(input, bodyFrom, size.value, segmentEnd);
      // A cluster with no timestamp in it is not a cluster this parser understands. Stopping
      // here used to mean silently keeping everything before it; now it is reported, and the
      // caller refuses rather than repackaging the first half of a recording.
      if (cluster === null) {
        stoppedAt = start;
        break;
      }
      clusters.push(cluster.cluster);
      durationTicks = Math.max(durationTicks, cluster.endTicks);
      reader.pos = cluster.cluster.childrenTo;
      continue;
    }

    // Every other element declares its length. One that does not, or one that runs past the
    // buffer, is where this walk ends; whether that is a cut-off recording or a broken one is
    // decided by `classifyTail`, not here.
    if (size.value === null || bodyFrom + size.value > segmentEnd) {
      stoppedAt = start;
      break;
    }
    const bodyTo = bodyFrom + size.value;

    if (id === ID.info) {
      const result = parseInfo(input, bodyFrom, bodyTo);
      infoChildren = result.children;
      timestampScale = result.timestampScale;
    } else if (id === ID.tracks) {
      tracks = input.subarray(start, bodyTo);
      tracksSummary = summarizeTracks(input, bodyFrom, bodyTo);
    }
    reader.pos = bodyTo;
  }

  if (infoChildren === null) throw new RemuxError("the Segment carries no Info element");
  if (tracks === null) throw new RemuxError("the Segment carries no Tracks element");
  if (clusters.length === 0) throw new RemuxError("the Segment carries no Cluster");

  return {
    ebmlHeader,
    infoChildren,
    tracks,
    tracksSummary,
    timestampScale,
    clusters,
    durationTicks,
    tail: classifyTail(input, stoppedAt ?? Math.max(reader.pos, segmentEnd)),
  };
}

/**
 * A live-written Cluster declares no size, so its end is found by reading its children until an
 * element turns up that belongs to the Segment rather than to the Cluster.
 */
function parseCluster(
  input: Uint8Array,
  bodyFrom: number,
  declaredSize: number | null,
  segmentEnd: number,
): { cluster: ParsedCluster; endTicks: number } | null {
  const hardEnd =
    declaredSize === null ? segmentEnd : Math.min(bodyFrom + declaredSize, segmentEnd);
  const reader = new Reader(input, bodyFrom, hardEnd);

  let timestamp: number | null = null;
  let lastBlockTicks = 0;
  let previousBlockTicks = 0;
  let childrenTo = bodyFrom;

  while (!reader.done) {
    const childStart = reader.pos;
    const id = reader.readId();
    if (id === null) break;
    if (declaredSize === null && SEGMENT_LEVEL_IDS.has(id)) {
      reader.pos = childStart;
      break;
    }
    const size = reader.readSize();
    if (size === null || size.value === null) break;
    const bodyTo = reader.pos + size.value;
    // A truncated final chunk: the element claims more bytes than the recording holds.
    // Everything before it is intact audio, so the cluster ends here.
    if (bodyTo > hardEnd) break;

    if (id === ID.timestamp) {
      timestamp = readUint(input, reader.pos, size.value);
    } else if (id === ID.simpleBlock || id === ID.blockGroup) {
      const relative = blockRelativeTimestamp(input, reader.pos, bodyTo, id);
      if (relative !== null && relative !== lastBlockTicks) {
        previousBlockTicks = lastBlockTicks;
        lastBlockTicks = relative;
      }
    }
    reader.pos = bodyTo;
    childrenTo = bodyTo;
  }

  if (timestamp === null) return null;
  // The last block's own playing time is not written down anywhere, so it is taken to be the
  // same as the gap before it — exact whenever the encoder uses a constant frame size, which
  // Opus from a `MediaRecorder` does. Where several blocks share a timestamp the gap is measured
  // between the distinct values, so the extrapolation is a frame out at worst: cosmetic on a
  // scrub bar, and nothing downstream reads it as a precise length.
  const trailing = Math.max(lastBlockTicks - previousBlockTicks, 0);
  return {
    cluster: { timestamp, childrenFrom: bodyFrom, childrenTo },
    endTicks: timestamp + lastBlockTicks + trailing,
  };
}

/** The signed, cluster-relative timestamp in a SimpleBlock or a BlockGroup's Block. */
function blockRelativeTimestamp(
  input: Uint8Array,
  from: number,
  to: number,
  id: number,
): number | null {
  let pos = from;
  if (id === ID.blockGroup) {
    // Only the Block child carries the timestamp; the rest of the group is metadata.
    const reader = new Reader(input, from, to);
    let found = -1;
    while (!reader.done) {
      const childId = reader.readId();
      if (childId === null) break;
      const size = reader.readSize();
      if (size === null || size.value === null) break;
      if (childId === 0xa1) {
        found = reader.pos;
        break;
      }
      reader.pos += size.value;
    }
    if (found === -1) return null;
    pos = found;
  }
  // [track number VINT][int16 relative timestamp][flags][frames]
  const first = input[pos];
  if (first === undefined) return null;
  let width = 1;
  for (let mask = 0x80; mask > 0 && (first & mask) === 0; mask >>= 1) width += 1;
  if (pos + width + 2 > to) return null;
  return new DataView(input.buffer, input.byteOffset + pos + width, 2).getInt16(0, false);
}

function parseInfo(
  input: Uint8Array,
  from: number,
  to: number,
): { children: Uint8Array[]; timestampScale: number } {
  const reader = new Reader(input, from, to);
  const children: Uint8Array[] = [];
  let timestampScale = DEFAULT_TIMESTAMP_SCALE;

  while (!reader.done) {
    const start = reader.pos;
    const id = reader.readId();
    if (id === null) break;
    const size = reader.readSize();
    if (size === null || size.value === null) break;
    const bodyTo = reader.pos + size.value;
    if (bodyTo > to) break;
    if (id === ID.timestampScale) {
      timestampScale = readUint(input, reader.pos, size.value);
    }
    // A Duration the live writer left behind is dropped: this pass writes the real one.
    if (id !== ID.duration) children.push(input.subarray(start, bodyTo));
    reader.pos = bodyTo;
  }
  return { children, timestampScale };
}

/** Matroska track types; only audio belongs in a recording this pipeline made. */
const TRACK_TYPE_AUDIO = 2;

interface TrackSummary {
  /** Track number of the first track, which is the one the cue index points at. */
  number: number;
  /** Track types found, so a stream carrying anything but audio can be refused. */
  types: number[];
}

function summarizeTracks(input: Uint8Array, from: number, to: number): TrackSummary {
  const summary: TrackSummary = { number: 1, types: [] };
  let first = true;
  const reader = new Reader(input, from, to);
  while (!reader.done) {
    const id = reader.readId();
    if (id === null) break;
    const size = reader.readSize();
    if (size === null || size.value === null) break;
    const bodyTo = reader.pos + size.value;
    if (bodyTo > to) break;
    if (id === ID.trackEntry) {
      const inner = new Reader(input, reader.pos, bodyTo);
      while (!inner.done) {
        const innerId = inner.readId();
        if (innerId === null) break;
        const innerSize = inner.readSize();
        if (innerSize === null || innerSize.value === null) break;
        if (innerId === ID.trackNumber && first) {
          summary.number = readUint(input, inner.pos, innerSize.value);
        } else if (innerId === ID.trackType) {
          summary.types.push(readUint(input, inner.pos, innerSize.value));
        }
        inner.pos += innerSize.value;
      }
      first = false;
    }
    reader.pos = bodyTo;
  }
  return summary;
}

/**
 * What the parser found where it stopped.
 *
 * The distinction this draws is the one the whole "verify, then delete" order depends on. A walk
 * that ends because the input ended has read the whole recording. A walk that ends anywhere else
 * has read *part* of one — and repackaging part of a recording and then deleting the rest is the
 * one outcome this job must never produce. So only two of these are allowed to continue.
 */
type Tail =
  /** The walk consumed the input. */
  | { kind: "complete" }
  /**
   * The input ends inside an element whose header is intact and whose body is cut short. This is
   * what a crash between two chunk writes leaves behind, and everything before it is real audio.
   */
  | { kind: "truncated"; at: number }
  /** A second EBML header: two recordings concatenated into one object. */
  | { kind: "second-segment"; at: number }
  /** Anything else — a corrupt element, a stop the parser cannot account for. */
  | { kind: "unreadable"; at: number };

function classifyTail(input: Uint8Array, pos: number): Tail {
  const remaining = input.byteLength - pos;
  if (remaining <= 0) return { kind: "complete" };

  const reader = new Reader(input, pos, input.byteLength);
  const idStart = reader.pos;
  const id = reader.readId();
  if (id === ID.ebml) return { kind: "second-segment", at: pos };
  if (id === null) {
    // `readId` says no for two different reasons, and they mean opposite things. Too few bytes
    // left for the width the first byte announces is a stream that stops mid-header — the same
    // cut-off recording as a truncated body, one step earlier. A first byte that is not the start
    // of any id at all is damage.
    return widthOf(input[idStart]) > remaining ? { kind: "truncated", at: pos } : mid(pos);
  }

  const sizeStart = reader.pos;
  const size = reader.readSize();
  if (size === null) {
    return widthOf(input[sizeStart]) > input.byteLength - sizeStart
      ? { kind: "truncated", at: pos }
      : mid(pos);
  }
  // An unknown-size element here is a cluster the walk gave up on, not a truncation.
  if (size.value === null) return mid(pos);
  if (reader.pos + size.value > input.byteLength) return { kind: "truncated", at: pos };
  return mid(pos);
}

function mid(pos: number): Tail {
  return { kind: "unreadable", at: pos };
}

/** Byte width a VINT starting with this byte announces, or 9 when it announces none. */
function widthOf(first: number | undefined): number {
  if (first === undefined) return 9;
  if (first === 0) return 9;
  let width = 1;
  for (let mask = 0x80; mask > 0 && (first & mask) === 0; mask >>= 1) width += 1;
  return width;
}

/**
 * SHARES NO CODE WITH THE PARSER ABOVE, deliberately. A parser that lost half a recording reports
 * the count it arrived at, and a verification that compared the artifact against *that* would
 * agree with itself no matter what was dropped. This gives the artifact a number to be held to
 * that the parser had no part in producing.
 *
 * The scan can over-count: the four-byte pattern can occur inside an Opus payload by chance. It
 * is used only to compare a source against an artifact whose cluster contents are copies of that
 * source's, so any accidental match inside the audio appears identically in both — which is what
 * makes the comparison sound even though the individual number is a lower bound at best.
 */
export function scanClusterMarks(input: Uint8Array): number {
  let found = 0;
  for (let i = 0; i + 3 < input.byteLength; i += 1) {
    if (
      input[i] === 0x1f &&
      input[i + 1] === 0x43 &&
      input[i + 2] === 0xb6 &&
      input[i + 3] === 0x75
    ) {
      found += 1;
    }
  }
  return found;
}

/**
 * The layout is deliberate on two counts. Cues sit *before* the clusters, so seeking a remote
 * recording costs one small ranged read of the head rather than a walk to the tail; and every
 * length the index depends on is written at a fixed width, so the byte positions it names can be
 * computed in one shot instead of by iterating a layout until it stops moving.
 */
export function remuxWebm(input: Uint8Array): RemuxResult {
  const parsed = parse(input);

  // Everything downstream of this function ends in the chunk objects being deleted, so a partial
  // read has to stop here rather than become a short file that looks perfectly valid.
  switch (parsed.tail.kind) {
    case "complete":
    case "truncated":
      break;
    case "second-segment":
      // Two recordings in one object — a recorder that was restarted mid-session appends a fresh
      // EBML header rather than continuing the stream. Everything after that header is real
      // audio, and this remuxer would silently swallow it as cluster payload. Merging the two
      // timelines is a different job from repackaging one; until something does it, saying so is
      // the only answer that does not lose a recording.
      throw new RemuxError(
        `the stream carries a second EBML header at byte ${parsed.tail.at}: it is two recordings, not one`,
      );
    case "unreadable":
      throw new RemuxError(
        `the stream could not be read past byte ${parsed.tail.at}, leaving ${input.byteLength - parsed.tail.at} bytes unaccounted for`,
      );
  }

  // A track this pipeline never produces is a stream this remuxer was never written against, and
  // a video-bearing recording would also be large enough for the whole-file buffering to matter.
  const foreign = parsed.tracksSummary.types.filter((type) => type !== TRACK_TYPE_AUDIO);
  if (foreign.length > 0) {
    throw new RemuxError(`the stream carries a non-audio track (type ${foreign[0] as number})`);
  }

  const durationTicks = parsed.durationTicks;
  const infoBody = new Writer();
  for (const child of parsed.infoChildren) infoBody.raw(child);
  infoBody.raw(floatElement(ID.duration, durationTicks));
  const infoBodyBytes = infoBody.concat();
  const info = new Writer();
  info.id(ID.info);
  info.size(infoBodyBytes.byteLength);
  info.raw(infoBodyBytes);
  const infoBytes = info.concat();

  const cueClusters: number[] = [];
  let nextCueAt = -1;
  parsed.clusters.forEach((cluster, index) => {
    const ms = (cluster.timestamp * parsed.timestampScale) / 1_000_000;
    if (ms >= nextCueAt) {
      cueClusters.push(index);
      nextCueAt = ms + CUE_INTERVAL_MS;
    }
  });

  // Sizes first, contents second: the index names byte positions, so the layout has to
  // be settled before a single position can be written.
  const CUE_POINT_BODY = 10 + 22; // CueTime + CueTrackPositions
  const cuesBodyLength = cueClusters.length * (1 + 1 + CUE_POINT_BODY);
  const cuesLength = 4 + sizeWidth(cuesBodyLength) + cuesBodyLength;
  const seekHeadLength = 4 + 1 + 3 * 21;

  const clusterHeaderLengths = parsed.clusters.map((cluster) => {
    const children = cluster.childrenTo - cluster.childrenFrom;
    return 4 + sizeWidth(children);
  });
  const clustersStart =
    seekHeadLength + infoBytes.byteLength + parsed.tracks.byteLength + cuesLength;
  const clusterPositions: number[] = [];
  let cursor = clustersStart;
  parsed.clusters.forEach((cluster, index) => {
    clusterPositions.push(cursor);
    cursor += (clusterHeaderLengths[index] as number) + (cluster.childrenTo - cluster.childrenFrom);
  });
  const segmentBodyLength = cursor;

  // Fixed-width positions keep the SeekHead a constant length, which the layout below needs.
  const seekHeadBody = new Writer();
  const entries: Array<[number, number]> = [
    [ID.info, seekHeadLength],
    [ID.tracks, seekHeadLength + infoBytes.byteLength],
    [ID.cues, seekHeadLength + infoBytes.byteLength + parsed.tracks.byteLength],
  ];
  for (const [id, position] of entries) {
    const seekBody = new Writer();
    seekBody.id(ID.seekId);
    seekBody.size(4);
    seekBody.id(id);
    seekBody.raw(uintElement(ID.seekPosition, position, 8));
    const body = seekBody.concat();
    seekHeadBody.id(ID.seek);
    seekHeadBody.size(body.byteLength);
    seekHeadBody.raw(body);
  }
  const seekHead = new Writer();
  seekHead.id(ID.seekHead);
  const seekHeadBodyBytes = seekHeadBody.concat();
  seekHead.size(seekHeadBodyBytes.byteLength);
  seekHead.raw(seekHeadBodyBytes);
  const seekHeadBytes = seekHead.concat();
  if (seekHeadBytes.byteLength !== seekHeadLength) {
    throw new RemuxError("the seek head did not come out at its computed length");
  }

  const cuesBody = new Writer();
  for (const index of cueClusters) {
    const positions = new Writer();
    positions.raw(uintElement(ID.cueTrack, parsed.tracksSummary.number, 8));
    positions.raw(uintElement(ID.cueClusterPosition, clusterPositions[index] as number, 8));
    const positionsBody = positions.concat();

    const point = new Writer();
    point.raw(uintElement(ID.cueTime, (parsed.clusters[index] as ParsedCluster).timestamp, 8));
    point.id(ID.cueTrackPositions);
    point.size(positionsBody.byteLength);
    point.raw(positionsBody);
    const pointBody = point.concat();

    cuesBody.id(ID.cuePoint);
    cuesBody.size(pointBody.byteLength);
    cuesBody.raw(pointBody);
  }
  const cues = new Writer();
  cues.id(ID.cues);
  const cuesBodyBytes = cuesBody.concat();
  cues.size(cuesBodyBytes.byteLength);
  cues.raw(cuesBodyBytes);
  const cuesBytes = cues.concat();
  if (cuesBytes.byteLength !== cuesLength) {
    throw new RemuxError("the cue index did not come out at its computed length");
  }

  const out = new Writer();
  out.raw(parsed.ebmlHeader);
  out.id(ID.segment);
  // Widest legal encoding, so the Segment's length can be written before the body it
  // measures has been laid out.
  out.size(segmentBodyLength, 8);
  const segmentBodyStart = out.bytes;
  out.raw(seekHeadBytes);
  out.raw(infoBytes);
  out.raw(parsed.tracks);
  out.raw(cuesBytes);
  for (const cluster of parsed.clusters) {
    const children = input.subarray(cluster.childrenFrom, cluster.childrenTo);
    out.id(ID.cluster);
    out.size(children.byteLength);
    out.raw(children);
  }
  if (out.bytes - segmentBodyStart !== segmentBodyLength) {
    throw new RemuxError("the segment did not come out at its computed length");
  }

  return {
    bytes: out.concat(),
    durationSeconds: (durationTicks * parsed.timestampScale) / 1_000_000_000,
    clusterCount: parsed.clusters.length,
    sourceClusterMarks: scanClusterMarks(input),
    cueCount: cueClusters.length,
  };
}

export interface WebmInspection {
  /** Whether the Segment carries a cue index — the thing a player seeks by. */
  hasCues: boolean;
  /** The playing time the file declares, or `null` when it declares none. */
  durationSeconds: number | null;
  /** How much of the recording the file still holds — see `scanClusterMarks`. */
  clusterCount: number;
}

/**
 * Deliberately not a re-run of the parser above. This walks the top level of the Segment and
 * believes only what the file says about itself, the way a player does; a check that recomputed
 * the answer with the same code that wrote it would agree with itself no matter what went wrong
 * on the way to storage.
 */
export function inspectWebm(input: Uint8Array): WebmInspection {
  const absent: WebmInspection = { hasCues: false, durationSeconds: null, clusterCount: 0 };
  const reader = new Reader(input, 0, input.byteLength);

  const ebmlId = reader.readId();
  const ebmlSize = reader.readSize();
  if (ebmlId !== ID.ebml || ebmlSize === null || ebmlSize.value === null) return absent;
  reader.pos += ebmlSize.value;

  const segmentId = reader.readId();
  const segmentSize = reader.readSize();
  if (segmentId !== ID.segment || segmentSize === null || segmentSize.value === null) return absent;
  const segmentEnd = Math.min(reader.pos + segmentSize.value, input.byteLength);

  let hasCues = false;
  let clusterCount = 0;
  let durationTicks: number | null = null;
  let timestampScale = DEFAULT_TIMESTAMP_SCALE;

  while (reader.pos < segmentEnd) {
    const id = reader.readId();
    if (id === null) break;
    const size = reader.readSize();
    if (size === null || size.value === null) break;
    const bodyFrom = reader.pos;
    const bodyTo = bodyFrom + size.value;
    if (bodyTo > segmentEnd) break;

    if (id === ID.cues) hasCues = true;
    if (id === ID.cluster) clusterCount += 1;
    if (id === ID.info) {
      const info = new Reader(input, bodyFrom, bodyTo);
      while (!info.done) {
        const childId = info.readId();
        if (childId === null) break;
        const childSize = info.readSize();
        if (childSize === null || childSize.value === null) break;
        if (childId === ID.timestampScale) {
          timestampScale = readUint(input, info.pos, childSize.value);
        } else if (childId === ID.duration && childSize.value === 8) {
          const view = new DataView(input.buffer, input.byteOffset + info.pos, 8);
          durationTicks = view.getFloat64(0, false);
        }
        info.pos += childSize.value;
      }
    }
    reader.pos = bodyTo;
  }

  return {
    hasCues,
    clusterCount,
    durationSeconds: durationTicks === null ? null : (durationTicks * timestampScale) / 1e9,
  };
}
