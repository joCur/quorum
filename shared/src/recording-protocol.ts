import { z } from "zod";
import { normalizeUserTitle } from "./meeting-title.js";

/**
 * The chunk streaming protocol, client ↔ server (ADR-002)
 * Control messages as JSON over WebSocket; audio chunks binary with a header.
 */

export const AudioFormatSchema = z.object({
  /** e.g. "opus" | "aac" — as delivered by the MediaRecorder, no re-encoding */
  codec: z.string(),
  /** e.g. "webm" | "ogg" | "mp4" (Safari) */
  container: z.string(),
  sampleRate: z.number().int().positive(),
  channels: z.number().int().positive(),
});

// ---- Client → Server ----

/**
 * Opens a recording session.
 *
 * ADDITIVE EVOLUTION: every field added here is optional with a default, so a
 * client built before the field existed keeps starting sessions unchanged. That
 * is the versioning contract for this message — an older client is not a client
 * to reject, it is a tab that was open across a deploy. A field whose absence
 * could not be given a meaning would need a new message type instead.
 */
export const SessionStartSchema = z.object({
  type: z.literal("session.start"),
  /**
   * The name the user typed, normalized here rather than trusted: our own client trims the
   * field, but the protocol is the boundary, and a title of spaces has to reach the meeting row
   * as "unnamed" — otherwise it is a name to the database, an empty line to the reader, and a
   * reason to refuse the title the summary would have suggested.
   */
  meetingTitle: z
    .string()
    .nullable()
    .default(null)
    .transform((title) => normalizeUserTitle(title)),
  audioFormat: AudioFormatSchema,
  /**
   * Template this meeting's first summary is made with. `null` — and an absent
   * field, which parses to `null` — means "no per-meeting choice", which falls
   * back to the user's default and then to the system template.
   *
   * Only the shape is checked here. Whether the template exists and belongs to
   * the caller is decided where the summary is enqueued, because a template can
   * be deleted between starting a recording and summarizing it; a check here
   * would go stale rather than make the value trustworthy.
   */
  summaryTemplateId: z.string().uuid().nullable().default(null),
  /**
   * Language this meeting is transcribed in — the first link of the chain in
   * `transcription-language.ts`. `auto` asks for detection; `null` — and an absent field, which
   * parses to `null` — is no statement at all and falls through to the user's default and then to
   * the deployment default.
   *
   * Not validated against the offered list here: the picker is a product decision that changes
   * faster than the sessions still in flight, and a tag this server does not recognize is refused
   * by the transcription backend rather than by the socket that carries the audio.
   */
  language: z.string().max(35).nullable().default(null),
  clientInfo: z.object({
    platform: z.string(), // e.g. "web-desktop" | "web-mobile"
    userAgent: z.string(),
  }),
});

export const SessionPauseSchema = z.object({
  type: z.literal("session.pause"),
  sessionId: z.string().uuid(),
  /** Wall-clock time of the pause — the basis for mapping audio time ↔ wall clock */
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
  /** The highest sequence number sent — the server checks for completeness */
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
  /** The last PERSISTED sequence number — the client may clear its buffer up to here */
  persistedSeq: z.number().int().nonnegative(),
});

export const SessionFinalizedSchema = z.object({
  type: z.literal("session.finalized"),
  sessionId: z.string().uuid(),
  meetingId: z.string().uuid(),
  /** The ID of the processing job that was created */
  jobId: z.string().uuid(),
});

/** Reserved in V1, never sent — a live transcript is purely additive later */
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

// ---- The binary chunk header ----
// Layout (little-endian): [16 B session UUID][4 B uint32 seq][8 B float64 timestampOffset s][rest: audio payload]
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
