import { z } from "zod";

/**
 * Async Job-API (ADR-002): Job anlegen → Status via Polling/SSE → Ergebnis abholen.
 */

export const JobTypeSchema = z.enum([
  "transcribe",
  "summarize",
  // Später: "diarize", "reprocess"
]);

export const JobStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "canceled",
]);

export const JobSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  type: JobTypeSchema,
  status: JobStatusSchema,
  /** 0..1, optional für Fortschrittsanzeige */
  progress: z.number().min(0).max(1).nullable().default(null),
  /** Einheitliches Fehlerformat über die gesamte API */
  error: z
    .object({
      code: z.string(), // maschinenlesbar, z. B. "AUDIO_DECODE_FAILED"
      message: z.string(), // menschenlesbar
    })
    .nullable()
    .default(null),
  /** Ergebnis-Referenz, z. B. transcriptId oder summaryId */
  resultId: z.string().uuid().nullable().default(null),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable().default(null),
  finishedAt: z.string().datetime().nullable().default(null),
});

export type Job = z.infer<typeof JobSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
