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
  /** Anzeigename, vom Nutzer umbenennbar ("Sprecher 1" → "Jonas") */
  label: z.string(),
  /** Später: Referenz auf gespeichertes Sprecherprofil zur Wiedererkennung */
  profileId: z.string().uuid().nullable().default(null),
});

export const SegmentSchema = z.object({
  /** Stabile ID — Ziel für Kommentare, Highlights, Summary-Quellenverweise */
  id: z.string().uuid(),
  start: z.number().nonnegative(),
  end: z.number().nonnegative(),
  /** Maschinen-Output, IMMUTABLE — wird nie überschrieben */
  text: z.string(),
  /** Nutzerkorrektur als Overlay; null = keine Korrektur */
  editedText: z.string().nullable().default(null),
  confidence: z.number().min(0).max(1).nullable().default(null),
  /** null bis Diarisierung existiert; referenziert Transcript.speakers[].id */
  speakerId: z.string().uuid().nullable().default(null),
  /** Nutzer-Override der Sprecherzuordnung (immutable Maschinen-Zuordnung bleibt in speakerId) */
  editedSpeakerId: z.string().uuid().nullable().default(null),
  /** Überschreibt Transcript.language für gemischtsprachige Meetings */
  language: z.string().nullable().default(null),
  /** Wort-Level-Timestamps — ab Tag 1 mitgespeichert (ADR-003 §4) */
  words: z.array(WordSchema).nullable().default(null),
});

export const TranscriptSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  schemaVersion: z.literal(TRANSCRIPT_SCHEMA_VERSION),
  /** Genau ein aktives Transcript pro Meeting (1:n, ADR-003 §3) */
  isActive: z.boolean(),
  /** Womit transkribiert wurde — Grundlage für Reprocessing */
  model: z.string(),
  modelVersion: z.string(),
  /** BCP-47, Default für alle Segmente */
  language: z.string(),
  /** Absoluter Startzeitpunkt der Aufnahme (Realzeit-Mapping) */
  recordedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  speakers: z.array(SpeakerSchema).default([]),
  segments: z.array(SegmentSchema),
});

export type Word = z.infer<typeof WordSchema>;
export type Speaker = z.infer<typeof SpeakerSchema>;
export type Segment = z.infer<typeof SegmentSchema>;
export type Transcript = z.infer<typeof TranscriptSchema>;
