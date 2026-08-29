import { CHUNK_HEADER_BYTES, ChunkMetaSchema, type ChunkMeta } from "@quorum/shared";

/**
 * Binary chunk frame (recording-protocol.ts, little-endian):
 * [16 B session UUID][4 B uint32 seq][8 B float64 timestampOffset s][audio payload]
 */

export interface ParsedChunk {
  meta: ChunkMeta;
  payload: Uint8Array;
}

export type ParseResult = { ok: true; chunk: ParsedChunk } | { ok: false; reason: string };

const HEX = "0123456789abcdef";

function uuidFromBytes(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < 16; i += 1) {
    const byte = bytes[i] as number;
    hex += HEX[(byte >> 4) & 0x0f];
    hex += HEX[byte & 0x0f];
  }
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function bytesFromUuid(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

export function parseChunkFrame(frame: Uint8Array): ParseResult {
  if (frame.length <= CHUNK_HEADER_BYTES) {
    return { ok: false, reason: "chunk frame is shorter than the protocol header" };
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  const meta = {
    sessionId: uuidFromBytes(frame.subarray(0, 16)),
    seq: view.getUint32(16, true),
    timestampOffset: view.getFloat64(20, true),
  };
  const parsed = ChunkMetaSchema.safeParse(meta);
  if (!parsed.success) {
    return { ok: false, reason: "chunk header failed protocol validation" };
  }
  return { ok: true, chunk: { meta: parsed.data, payload: frame.subarray(CHUNK_HEADER_BYTES) } };
}

/** Encodes a chunk frame — used by the tests and available to client tooling. */
export function encodeChunkFrame(meta: ChunkMeta, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(CHUNK_HEADER_BYTES + payload.length);
  frame.set(bytesFromUuid(meta.sessionId), 0);
  const view = new DataView(frame.buffer);
  view.setUint32(16, meta.seq, true);
  view.setFloat64(20, meta.timestampOffset, true);
  frame.set(payload, CHUNK_HEADER_BYTES);
  return frame;
}
