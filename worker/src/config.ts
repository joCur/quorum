import { z } from "zod";

/**
 * Environment configuration — names match `docker-compose.yml` / `.env.example`.
 *
 * Everything the worker needs to talk to a transcription backend is a URL and a
 * model name (ADR-005): the same code runs against the `speaches` container in
 * the compose stack, against a whisperX serving image later, or against
 * whisper.cpp running natively on a macOS host.
 */
export const WorkerConfigSchema = z.object({
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),

  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),

  /** OpenAI-compatible base URL, including the `/v1` suffix. */
  WHISPER_BASE_URL: z.string().min(1).default("http://whisper:8000/v1"),
  WHISPER_MODEL: z.string().min(1).default("small"),
  /** Optional bearer token — self-hosted backends usually need none. */
  WHISPER_API_KEY: z.string().optional(),
  /**
   * BCP-47 hint passed to the backend. Empty means "let the model detect the
   * language", which is what we want for mixed-language meetings.
   */
  WHISPER_LANGUAGE: z.string().optional(),
  /** Whole-request timeout for one transcription call. */
  WHISPER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(30 * 60_000),

  /** How many transcriptions this process runs at the same time. */
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(1),
  /** Attempts per job before it is dead-lettered. */
  WORKER_RETRY_LIMIT: z.coerce.number().int().nonnegative().default(4),
  /** Base delay for the exponential retry backoff, in seconds. */
  WORKER_RETRY_DELAY_SECONDS: z.coerce.number().int().positive().default(30),
  /**
   * Wall-clock budget for a single attempt. pg-boss returns the job to the queue
   * when an attempt exceeds it, so it must be larger than `WHISPER_TIMEOUT_MS`.
   */
  WORKER_JOB_EXPIRE_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(2 * 3600),
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  return WorkerConfigSchema.parse(env);
}
