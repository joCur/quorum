import type { AudioFormat } from "@quorum/shared";
import { audioKey, seqFromChunkKey, type KeyScope } from "../recording/keys.js";
import type { ByteRange, StoredObject } from "../recording/types.js";

/**
 * Playback assembly.
 *
 * A recording exists in one of two shapes, and this module is what makes the difference invisible
 * from the outside. Fresh from the recorder it is one object per chunk (ADR-002), and playback
 * concatenates them back into the stream the browser produced. Once the pipeline has repackaged
 * it (ADR-010) it is a single seekable file, and playback serves ranges of that.
 *
 * Nothing is ever written back from here. Assembling on read is what keeps the stored objects the
 * single copy of the audio, which is also what makes the deletion cascade of ADR-001 a plain
 * prefix removal in both shapes.
 */

/** One chunk object in playback order, with the byte offset it starts at in the stream. */
export interface AudioPart {
  key: string;
  size: number;
  /** Offset of this chunk's first byte within the concatenated stream. */
  offset: number;
}

export interface AudioLayout {
  parts: AudioPart[];
  /** Total length of the concatenated stream in bytes. */
  totalBytes: number;
}

/**
 * Works out what to serve for a session, and from which objects.
 *
 * The repackaged file wins whenever it is there. Its mere presence is the signal, and that is
 * safe by construction rather than by hope: the pipeline writes the artifact under a staging name
 * and only gives it this name once it has read it back and checked it (ADR-010), so an object
 * carrying this key is one that has already passed. Everything else is the chunk shape.
 *
 * Chunk ordering comes from the sequence number parsed out of the key rather than from the
 * listing order. Lexicographic order happens to agree because the sequence is zero-padded, but
 * relying on that would make the audio silently depend on a storage implementation detail.
 */
export function audioLayout(objects: readonly StoredObject[], scope: KeyScope): AudioLayout {
  const remuxed = objects.find((object) => object.key === audioKey(scope));
  if (remuxed) {
    return {
      parts: [{ key: remuxed.key, size: remuxed.size, offset: 0 }],
      totalBytes: remuxed.size,
    };
  }

  const chunks = objects
    .map((object) => ({ object, seq: seqFromChunkKey(object.key) }))
    .filter((entry): entry is { object: StoredObject; seq: number } => entry.seq !== null)
    .sort((a, b) => a.seq - b.seq);

  let offset = 0;
  const parts = chunks.map((entry) => {
    const part: AudioPart = { key: entry.object.key, size: entry.object.size, offset };
    offset += entry.object.size;
    return part;
  });
  return { parts, totalBytes: offset };
}

export type RangeResult =
  { kind: "full" } | { kind: "partial"; range: ByteRange } | { kind: "unsatisfiable" };

/**
 * Interprets an HTTP `Range` header against a known total size.
 *
 * Only a single byte range is honored — multipart ranges buy nothing for audio playback and
 * would need a multipart response body. Anything not understood falls back to the full stream,
 * which RFC 9110 explicitly allows.
 */
export function resolveRange(header: string | undefined, totalBytes: number): RangeResult {
  if (header === undefined) return { kind: "full" };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return { kind: "full" };

  const [, rawFrom, rawTo] = match;
  if (rawFrom === "" && rawTo === "") return { kind: "full" };
  if (totalBytes === 0) return { kind: "unsatisfiable" };

  // `bytes=-500` asks for the last 500 bytes.
  if (rawFrom === "") {
    const suffix = Number(rawTo);
    if (suffix === 0) return { kind: "unsatisfiable" };
    const from = Math.max(totalBytes - suffix, 0);
    return { kind: "partial", range: { from, to: totalBytes - 1 } };
  }

  const from = Number(rawFrom);
  if (from >= totalBytes) return { kind: "unsatisfiable" };
  const to = rawTo === "" ? totalBytes - 1 : Math.min(Number(rawTo), totalBytes - 1);
  if (to < from) return { kind: "unsatisfiable" };
  return { kind: "partial", range: { from, to } };
}

/** A slice of one chunk object that contributes to the requested range. */
export interface PartSlice {
  key: string;
  /** Inclusive byte range within the chunk object, or `undefined` for the whole object. */
  range: ByteRange | undefined;
}

/** Selects the chunk objects overlapping `[from, to]` and the slice needed from each. */
export function slicesForRange(layout: AudioLayout, range: ByteRange): PartSlice[] {
  const slices: PartSlice[] = [];
  for (const part of layout.parts) {
    const partEnd = part.offset + part.size - 1;
    if (partEnd < range.from || part.offset > range.to) continue;
    const from = Math.max(range.from - part.offset, 0);
    const to = Math.min(range.to - part.offset, part.size - 1);
    slices.push({
      key: part.key,
      range: from === 0 && to === part.size - 1 ? undefined : { from, to },
    });
  }
  return slices;
}

/** Media type for the container the recording was captured in. */
export function audioContentType(format: AudioFormat): string {
  switch (format.container) {
    case "webm":
      return "audio/webm";
    case "ogg":
      return "audio/ogg";
    case "mp4":
      return "audio/mp4";
    default:
      return "application/octet-stream";
  }
}
