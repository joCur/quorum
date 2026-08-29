import { CHUNK_HEADER_BYTES, type ChunkMeta } from "@quorum/shared";

/**
 * Binary chunk frame, little-endian, exactly as defined next to the protocol
 * schema:
 *
 *   [16 B session UUID][4 B uint32 seq][8 B float64 timestampOffset s][payload]
 */
export function encodeChunkFrame(meta: ChunkMeta, payload: Uint8Array): Uint8Array {
  const frame = new Uint8Array(CHUNK_HEADER_BYTES + payload.length);
  frame.set(uuidToBytes(meta.sessionId), 0);
  const view = new DataView(frame.buffer);
  view.setUint32(16, meta.seq, true);
  view.setFloat64(20, meta.timestampOffset, true);
  frame.set(payload, CHUNK_HEADER_BYTES);
  return frame;
}

function uuidToBytes(uuid: string): Uint8Array {
  const hex = uuid.replace(/-/g, "");
  if (hex.length !== 32) {
    throw new Error(`Not a UUID: ${uuid}`);
  }
  const bytes = new Uint8Array(16);
  for (let index = 0; index < 16; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}
