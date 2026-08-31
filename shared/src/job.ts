import { z } from "zod";

/**
 * The async job API (ADR-002): create a job → status via polling/SSE → fetch the result.
 */

export const JobTypeSchema = z.enum([
  "transcribe",
  "summarize",
  // Later: "diarize", "reprocess"
]);

export const JobStatusSchema = z.enum(["queued", "running", "succeeded", "failed", "canceled"]);

export const JobSchema = z.object({
  id: z.string().uuid(),
  meetingId: z.string().uuid(),
  type: JobTypeSchema,
  status: JobStatusSchema,
  /** 0..1, optional, for a progress indicator */
  progress: z.number().min(0).max(1).nullable().default(null),
  /** A uniform error format across the whole API */
  error: z
    .object({
      code: z.string(), // machine-readable, e.g. "AUDIO_DECODE_FAILED"
      message: z.string(), // human-readable
    })
    .nullable()
    .default(null),
  /** A reference to the result, e.g. transcriptId or summaryId */
  resultId: z.string().uuid().nullable().default(null),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable().default(null),
  finishedAt: z.string().datetime().nullable().default(null),
});

export type Job = z.infer<typeof JobSchema>;
export type JobStatus = z.infer<typeof JobStatusSchema>;
