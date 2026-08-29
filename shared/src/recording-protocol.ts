import { z } from "zod";

/**
 * Chunk-Streaming-Protokoll Client ↔ Server (ADR-002)
 * Control-Messages als JSON über WebSocket; Audio-Chunks binär mit Header.
 */

export const AudioFormatSchema = z.object({
  /** z. B. "opus" | "aac" — wie vom MediaRecorder geliefert, kein Re-Encoding */
  codec: z.string(),
  /** z. B. "webm" | "ogg" | "mp4" (Safari) */
  container: z.string(),
  sampleRate: z.number().int().positive(),
  channels: z.number().int().positive(),
});

// ---- Client → Server ----

export const SessionStartSchema = z.object({
  type: z.literal("session.start"),
  meetingTitle: z.string().nullable().default(null),
  audioFormat: AudioFormatSchema,
  clientInfo: z.object({
    platform: z.string(), // z. B. "web-desktop" | "web-mobile"
    userAgent: z.string(),
  }),
});

export const SessionPauseSchema = z.object({
  type: z.literal("session.pause"),
  sessionId: z.string().uuid(),
  /** Realzeit der Pause — Grundlage für Audio-Zeit ↔ Wanduhr-Mapping */
  at: z.string().datetime(),
});

export const SessionResumeSchema = z.object({
  type: z.literal("session.resume"),
  sessionId: z.string().uuid(),
  at: z.string().datetime(),
});

export const SessionEndSchema = z.object({
  type: z.literal("session.end"),
  sessionId: z.string().uuid(),
  /** Höchste gesendete Sequenznummer — Server prüft Vollständigkeit */
  lastSeq: z.number().int().nonnegative(),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  SessionStartSchema,
  SessionPauseSchema,
  SessionResumeSchema,
  SessionEndSchema,
]);

// ---- Server → Client ----

export const SessionReadySchema = z.object({
  type: z.literal("session.ready"),
  sessionId: z.string().uuid(),
});

export const ChunkAckSchema = z.object({
  type: z.literal("chunk.ack"),
  sessionId: z.string().uuid(),
  /** Letzte PERSISTIERTE Sequenznummer — Client darf bis hierhin seinen Puffer leeren */
  persistedSeq: z.number().int().nonnegative(),
});

export const SessionFinalizedSchema = z.object({
  type: z.literal("session.finalized"),
  sessionId: z.string().uuid(),
  meetingId: z.string().uuid(),
  /** ID des angelegten Verarbeitungs-Jobs */
  jobId: z.string().uuid(),
});

/** In V1 reserviert, wird nie gesendet — Live-Transkript später rein additiv */
export const TranscriptPartialSchema = z.object({
  type: z.literal("transcript.partial"),
  sessionId: z.string().uuid(),
  segments: z.array(z.unknown()),
});

export const ServerMessageSchema = z.discriminatedUnion("type", [
  SessionReadySchema,
  ChunkAckSchema,
  SessionFinalizedSchema,
  TranscriptPartialSchema,
]);

// ---- Binärer Chunk-Header ----
// Layout (little-endian): [16 B Session-UUID][4 B uint32 seq][8 B float64 timestampOffset s][Rest: Audio-Payload]
export const CHUNK_HEADER_BYTES = 28;

export const ChunkMetaSchema = z.object({
  sessionId: z.string().uuid(),
  seq: z.number().int().nonnegative(),
  /** Sekunden seit Aufnahmestart (Audio-Zeit, Pausen ausgenommen) */
  timestampOffset: z.number().nonnegative(),
});

export type AudioFormat = z.infer<typeof AudioFormatSchema>;
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ChunkMeta = z.infer<typeof ChunkMetaSchema>;
