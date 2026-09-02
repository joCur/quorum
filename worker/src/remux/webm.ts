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
 * WHAT THIS DOES ABOUT IT. One parse, then one write. The audio itself is copied
 * byte for byte — every Cluster's children are moved across verbatim, so not a single
 * Opus packet is touched. Only the container's bookkeeping is rewritten: sizes are
 * declared, a Duration is computed from the block timestamps, and a Cues index is
 * built and placed *before* the clusters, so a player learns the whole map from the
 * first few kilobytes instead of having to read to the end of a long recording.
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
  /** The seekable file. */
  bytes: Uint8Array;
  /** Playing time of the recording, from the block timestamps. */
  durationSeconds: number;
  /** Clusters carried over — unchanged, since none are merged or split. */
  clusterCount: number;
  /** Entries in the generated index. */
  cueCount: number;
}

/** A cursor over one buffer, with every read bounds-checked. */
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
    return { value: unknown ? null : value };
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

/** One cluster as the parser found it: where its children are, and when it starts. */
interface ParsedCluster {
  timestamp: number;
  childrenFrom: number;
  childrenTo: number;
}

interface Parsed {
  ebmlHeader: Uint8Array;
  infoChildren: Uint8Array[];
  tracks: Uint8Array;
  trackNumber: number;
  timestampScale: number;
  clusters: ParsedCluster[];
  /** End of the last block, in timestamp units. */
  durationTicks: number;
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
  let trackNumber = 1;
  let timestampScale = DEFAULT_TIMESTAMP_SCALE;
  const clusters: ParsedCluster[] = [];
  let durationTicks = 0;

  while (reader.pos < segmentEnd) {
    const start = reader.pos;
    const id = reader.readId();
    if (id === null) break;
    const size = reader.readSize();
    if (size === null) break;
    const bodyFrom = reader.pos;

    if (id === ID.cluster) {
      const cluster = parseCluster(input, bodyFrom, size.value, segmentEnd);
      if (cluster === null) break;
      clusters.push(cluster.cluster);
      durationTicks = Math.max(durationTicks, cluster.endTicks);
      reader.pos = cluster.cluster.childrenTo;
      continue;
    }

    // Every other element declares its length; one that does not, or one that runs past
    // the buffer, means the stream was cut off and there is nothing further to read.
    if (size.value === null || bodyFrom + size.value > segmentEnd) break;
    const bodyTo = bodyFrom + size.value;

    if (id === ID.info) {
      const result = parseInfo(input, bodyFrom, bodyTo);
      infoChildren = result.children;
      timestampScale = result.timestampScale;
    } else if (id === ID.tracks) {
      tracks = input.subarray(start, bodyTo);
      trackNumber = firstTrackNumber(input, bodyFrom, bodyTo) ?? 1;
    }
    reader.pos = bodyTo;
  }

  if (infoChildren === null) throw new RemuxError("the Segment carries no Info element");
  if (tracks === null) throw new RemuxError("the Segment carries no Tracks element");
  if (clusters.length === 0) throw new RemuxError("the Segment carries no Cluster");

  return { ebmlHeader, infoChildren, tracks, trackNumber, timestampScale, clusters, durationTicks };
}

/**
 * Walks one Cluster and reports where it ends.
 *
 * A live-written Cluster declares no size, so its end is found by reading its children
 * until an element turns up that belongs to the Segment rather than to the Cluster.
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
  // The last block's own playing time is not written down anywhere, so it is taken to be
  // the same as the gap before it — exact whenever the encoder uses a constant frame size,
  // which Opus from a `MediaRecorder` does.
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

function firstTrackNumber(input: Uint8Array, from: number, to: number): number | null {
  const reader = new Reader(input, from, to);
  while (!reader.done) {
    const id = reader.readId();
    if (id === null) return null;
    const size = reader.readSize();
    if (size === null || size.value === null) return null;
    const bodyTo = reader.pos + size.value;
    if (bodyTo > to) return null;
    if (id === ID.trackEntry) {
      const inner = new Reader(input, reader.pos, bodyTo);
      while (!inner.done) {
        const innerId = inner.readId();
        if (innerId === null) break;
        const innerSize = inner.readSize();
        if (innerSize === null || innerSize.value === null) break;
        if (innerId === ID.trackNumber) return readUint(input, inner.pos, innerSize.value);
        inner.pos += innerSize.value;
      }
      return null;
    }
    reader.pos = bodyTo;
  }
  return null;
}

/**
 * Rewrites a live WebM stream as a seekable file.
 *
 * The layout it produces is deliberate. Cues sit *before* the clusters, so seeking a
 * remote recording costs one small ranged read of the head rather than a walk to the
 * tail; and every length that the index depends on is written at a fixed width, so the
 * byte positions the index names can be computed in one shot instead of by iterating
 * a layout until it stops moving.
 */
export function remuxWebm(input: Uint8Array): RemuxResult {
  const parsed = parse(input);

  // Info, with the Duration this pass computed.
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

  // One cue every CUE_INTERVAL_MS, and always the first cluster.
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

  // SeekHead — fixed-width positions keep its own length constant.
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

  // Cues.
  const cuesBody = new Writer();
  for (const index of cueClusters) {
    const positions = new Writer();
    positions.raw(uintElement(ID.cueTrack, parsed.trackNumber, 8));
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

  // The file.
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
    cueCount: cueClusters.length,
  };
}

export interface WebmInspection {
  /** Whether the Segment carries a cue index — the thing a player seeks by. */
  hasCues: boolean;
  /** The playing time the file declares, or `null` when it declares none. */
  durationSeconds: number | null;
  /** Clusters actually present, which is how much of the recording the file still holds. */
  clusterCount: number;
}

/**
 * Reads back the two properties that decide whether a file is seekable at all.
 *
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
