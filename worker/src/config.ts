import { z } from "zod";

/**
 * The largest delay `setTimeout` can hold. Node keeps it in a signed 32-bit
 * integer and silently truncates anything above, firing the timer after a
 * millisecond — so a timeout set past this ceiling would not be patient, it
 * would abort every request instantly. Better refused at startup than diagnosed
 * later from a pipeline that fails for no visible reason.
 */
const MAX_TIMEOUT_MS = 2_147_483_647;

/**
 * Environment configuration — names match `docker-compose.yml` / `.env.example`.
 *
 * Everything the worker needs to talk to a transcription backend is a URL and a
 * model name (ADR-005): the same code runs against the `speaches` container in
 * the compose stack, against a whisperX serving image later, or against
 * whisper.cpp running natively on a macOS host.
 */
const WorkerConfigFields = z.object({
  LOG_LEVEL: z.string().default("info"),
  DATABASE_URL: z.string().min(1),

  /**
   * Port for the worker's tiny HTTP surface: `GET /metrics` and `GET /healthz`.
   * Internal to the compose network — never published to a host port.
   */
  WORKER_METRICS_PORT: z.coerce.number().int().positive().max(65535).default(9091),

  S3_ENDPOINT: z.string().min(1),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),

  /** OpenAI-compatible base URL, including the `/v1` suffix. */
  WHISPER_BASE_URL: z.string().min(1).default("http://whisper:8000/v1"),
  /**
   * A full model ID, not a size: the backend serves only models it has on disk
   * under that exact ID and rejects a short name like `small` with a 404.
   */
  WHISPER_MODEL: z.string().min(1).default("Systran/faster-whisper-small"),
  /** Optional bearer token — self-hosted backends usually need none. */
  WHISPER_API_KEY: z.string().optional(),
  /**
   * Install `WHISPER_MODEL` on the transcription backend at startup when it is
   * not on disk yet, and refuse to consume jobs until it is.
   *
   * On by default, because the alternative is a deployment that looks healthy
   * and dead-letters the first recording anyone makes: downloading a model to
   * disk is an explicit step in the backend's API, and only loading it into
   * memory happens on demand. Turn it off for a backend that serves a baked-in
   * model, or where an operator manages the model cache by hand.
   */
  WHISPER_MODEL_AUTO_INSTALL: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  /**
   * Budget for the whole provisioning step — waiting for the backend to come up
   * plus the download itself. Generous by default, because `large-v3` is several
   * gigabytes over whatever line the deployment has; exceeding it is a loud
   * startup failure rather than a silently degraded worker.
   */
  WHISPER_MODEL_INSTALL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(45 * 60_000),
  /**
   * BCP-47 hint passed to the backend. Empty means "let the model detect the
   * language", which is what we want for mixed-language meetings.
   */
  WHISPER_LANGUAGE: z.string().optional(),
  /**
   * Send `vad_filter=true` with every transcription request, so the backend runs
   * Silero VAD and transcribes only the parts that contain speech.
   *
   * On by default, because the failure it prevents is severe and silent: a
   * recording with a long speechless stretch — a room left running before the
   * meeting starts — makes every Whisper size lock onto a repeated phrase, and
   * the loop then contaminates the rest of the transcript. The trade-off is that
   * audio the VAD considers silence is never transcribed at all.
   */
  WHISPER_VAD_FILTER: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
  /**
   * Whole-request timeout for one transcription call: it bounds the wait for
   * response headers, the read of the body, and the abort signal alike.
   */
  WHISPER_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .default(30 * 60_000),

  /**
   * Summary backend — OpenAI-compatible chat completions (ADR-005 §2). Today a
   * hosted router, later a self-hosted server: base URL, model name and key are
   * the only difference, which is what keeps the provider switch code-free.
   */
  SUMMARY_BASE_URL: z.string().min(1).default("https://openrouter.ai/api/v1"),
  SUMMARY_MODEL: z.string().min(1).default("openai/gpt-4o-mini"),
  /** Optional bearer token — self-hosted backends usually need none. */
  SUMMARY_API_KEY: z.string().optional(),
  /** Low but not zero, so a repetitive transcript cannot send the model into a loop. */
  SUMMARY_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.2),
  /**
   * Ceiling on the transcript text handed to the model, in estimated tokens.
   * `docs/COST-MODEL.md` budgets 12–15k input tokens per meeting hour; longer
   * recordings get their middle elided rather than producing an unbounded bill
   * or a context-length error (see `summary/transcript-window.ts`).
   */
  SUMMARY_MAX_INPUT_TOKENS: z.coerce.number().int().positive().default(14_000),
  /** Output ceiling. A structured summary is far smaller than its transcript. */
  SUMMARY_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().default(4_000),
  SUMMARY_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .max(MAX_TIMEOUT_MS)
    .default(3 * 60_000),
  /**
   * Send `response_format: {"type":"json_object"}`. Off by default because
   * several self-hosted OpenAI-compatible servers reject a field they do not
   * implement, and ADR-005 is about that swap staying free. Turn it on for a
   * backend that supports it: it makes malformed output rarer, not impossible.
   */
  SUMMARY_JSON_MODE: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),

  /** How many transcriptions this process runs at the same time. */
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(1),
  /**
   * Summaries in flight per process. Higher than the transcription default on
   * purpose: a summary job spends its whole life waiting on someone else's HTTP
   * endpoint rather than on the local GPU.
   */
  SUMMARY_CONCURRENCY: z.coerce.number().int().positive().default(2),
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

/**
 * The fields plus the constraints that span two of them.
 */
export const WorkerConfigSchema = WorkerConfigFields.superRefine((config, ctx) => {
  // Until now this invariant lived in a comment, which is to say it did not
  // exist. pg-boss returns an attempt to the queue the moment it expires and
  // another worker picks it up, so an expiry shorter than the transcription
  // timeout re-runs a transcription that is still legitimately in flight: the
  // backend computes the same audio twice at once, on a host that was already
  // too slow, and the loser's result overwrites the winner's. A deployment that
  // raises one of the two without the other should not start.
  if (config.WORKER_JOB_EXPIRE_SECONDS * 1_000 <= config.WHISPER_TIMEOUT_MS) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["WORKER_JOB_EXPIRE_SECONDS"],
      message:
        `WORKER_JOB_EXPIRE_SECONDS (${config.WORKER_JOB_EXPIRE_SECONDS} s) must be greater than ` +
        `WHISPER_TIMEOUT_MS (${config.WHISPER_TIMEOUT_MS} ms): an attempt would be handed to a ` +
        `second worker while the first is still waiting for its transcript, and the same audio ` +
        `would be transcribed twice`,
    });
  }
});

export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

/**
 * Reads and validates the environment, or refuses to start.
 *
 * The issues are flattened into one sentence on purpose: a misconfigured
 * container is read as a single line in `docker compose logs`, and a raw
 * validation dump is where an operator stops reading.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const result = WorkerConfigSchema.safeParse(env);
  if (result.success) return result.data;

  const detail = result.error.issues
    .map((issue) => `${issue.path.join(".") || "configuration"}: ${issue.message}`)
    .join("; ");
  throw new Error(`invalid worker configuration — ${detail}`);
}
