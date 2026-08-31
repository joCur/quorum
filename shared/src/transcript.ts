import { z } from "zod";

/**
 * Transcript-Schema (ADR-003)
 * Grundprinzipien: stabile Segment-IDs, immutabler Maschinen-Output,
 * Meeting→Transcript 1:n, Wort-Timestamps ab Tag 1.
 */

export const TRANSCRIPT_SCHEMA_VERSION = 1;

export const WordSchema = z.object({
  word: z.string(),
  /** Sekunden relativ zum Aufnahmestart */
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
});

export const SpeakerSchema = z.object({
  id: z.string().uuid(),
  /** Display name, renameable by the user ("Speaker 1" → "Jonas") */
  label: z.string(),
  /** Later: a reference to a stored speaker profile for re-identification */
  profileId: z.string().uuid().nullable().default(null),
});

export const SegmentSchema = z.object({
  /** A stable ID — the target for comments, highlights and summary source references */
  id: z.string().uuid(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  /** Machine output, IMMUTABLE — never overwritten */
  text: z.string(),
  /** A user correction as an overlay; null = no correction */
  editedText: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).nullable().default(null),
  /** null until diarization exists; references Transcript.speakers[].id */
  speakerId: z.string().uuid().nullable().default(null),
  /** A user override of the speaker assignment (the immutable machine assignment stays in speakerId) */
  editedSpeakerId: z.string().uuid().nullable().default(null),
  /** Overrides Transcript.language for multilingual meetings */
  language: z.string().nullable().default(null),
  /** Word-level timestamps — stored from day one (ADR-003 §4) */
  words: z.array(WordSchema).nullable().default(null),
});

export const TranscriptSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  schemaVersion: z.literal(TRANSCRIPT_SCHEMA_VERSION),
  /** Exactly one active transcript per meeting (1:n, ADR-003 §3) */
  isActive: z.boolean(),
  /** What it was transcribed with — the basis for reprocessing */
  model: z.string(),
  modelVersion: z.string(),
  /** BCP-47, the default for all segments */
  language: z.string(),
  /** The absolute start time of the recording (real-time mapping) */
  recordedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  speakers: z.array(SpeakerSchema).default([]),
  segments: z.array(SegmentSchema),
});

export type Word = z.infer<typeof WordSchema>;
export type Speaker = z.infer<typeof SpeakerSchema>;
export type Segment = z.infer<typeof SegmentSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;
