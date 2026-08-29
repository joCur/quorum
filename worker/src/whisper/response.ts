import { z } from "zod";

/**
 * The `verbose_json` response of the OpenAI audio transcription API, as far as
 * we rely on it. Everything except `text` is optional because the backends we
 * support differ in what they fill in:
 *
 * - `speaches` (compose stack today) returns segments, each with its own
 *   `words[]` when word granularity is requested.
 * - OpenAI itself returns a top-level `words[]` and segments without words.
 * - whisper.cpp / mlx-whisper on a macOS host sit somewhere in between.
 *
 * Unknown fields are ignored rather than rejected, so a backend upgrade that
 * adds keys does not fail every job.
 */

export const WhisperWordSchema = z.object({
  word: z.string(),
  start: z.number(),
  end: z.number(),
});

export const WhisperSegmentSchema = z.object({
  id: z.union([z.number(), z.string()]).optional(),
  start: z.number(),
  end: z.number(),
  text: z.string(),
  /** Mean log probability of the tokens; the basis for our confidence value. */
  avg_logprob: z.number().optional(),
  no_speech_prob: z.number().optional(),
  language: z.string().optional(),
  words: z.array(WhisperWordSchema).optional(),
});

export const WhisperTranscriptionResponseSchema = z.object({
  task: z.string().optional(),
  language: z.string().optional(),
  duration: z.number().optional(),
  text: z.string().default(""),
  model: z.string().optional(),
  segments: z.array(WhisperSegmentSchema).optional(),
  words: z.array(WhisperWordSchema).optional(),
});

export type WhisperWord = z.infer<typeof WhisperWordSchema>;
export type WhisperSegment = z.infer<typeof WhisperSegmentSchema>;
export type WhisperTranscriptionResponse = z.infer<typeof WhisperTranscriptionResponseSchema>;
