import { PgBoss } from "pg-boss";
import { loadConfig } from "./config.js";
import { createLogger, logQueueError } from "./logger.js";
import { PostgresRepository } from "./db/repository.js";
import { S3AudioSource } from "./storage/audio-source.js";
import { OpenAiTranscriptionClient } from "./whisper/client.js";
import { OpenAiChatClient } from "./summary/chat-client.js";
import { PgBossSummaryEnqueuer } from "./summary/enqueue.js";
import { SYSTEM_SUMMARY_TEMPLATE } from "./summary/template.js";
import { startSummarizeWorker, startTranscribeWorker } from "./worker.js";
import { createWorkerMetrics } from "./observability/metrics.js";
import { startMetricsServer } from "./observability/server.js";

export { loadConfig, WorkerConfigSchema, type WorkerConfig } from "./config.js";
export { createLogger, type WorkerLogger } from "./logger.js";
export * from "./errors.js";
export * from "./ids.js";
export * from "./payload.js";
export * from "./storage/keys.js";
export * from "./storage/manifest.js";
export { S3AudioSource, type AudioSource } from "./storage/audio-source.js";
export * from "./whisper/response.js";
export {
  OpenAiTranscriptionClient,
  type TranscriptionClient,
  type TranscriptionRequest,
} from "./whisper/client.js";
export * from "./transcript/map.js";
export { MIGRATIONS } from "./db/schema.js";
export {
  PostgresRepository,
  type TranscriptRepository,
  type SummaryRepository,
  type SaveTranscriptResult,
  type SaveSummaryResult,
  type JobScope,
} from "./db/repository.js";
export {
  runTranscribeJob,
  type TranscribeHandlerDependencies,
  type TranscribeOutcome,
} from "./handler.js";
export * from "./summary/template.js";
export * from "./summary/transcript-window.js";
export * from "./summary/prompt.js";
export * from "./summary/parse.js";
export * from "./summary/map.js";
export * from "./summary/enqueue.js";
export {
  OpenAiChatClient,
  type ChatCompletionClient,
  type ChatCompletionResult,
  type ChatMessage,
} from "./summary/chat-client.js";
export {
  runSummarizeJob,
  type SummarizeHandlerDependencies,
  type SummarizeOutcome,
} from "./summary/handler.js";
export * from "./observability/metrics.js";
export {
  startMetricsServer,
  type MetricsServer,
  type MetricsServerOptions,
} from "./observability/server.js";
export {
  startTranscribeWorker,
  startSummarizeWorker,
  type TranscribeWorkerOptions,
  type SummarizeWorkerOptions,
  type QueuePolicy,
} from "./worker.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);

  const repository = new PostgresRepository(config.DATABASE_URL);
  await repository.migrate();
  // The system default template has to exist before the first summary job runs
  // (ADR-004 §1). Seeding is an insert-if-absent of one immutable version, so
  // every replica can do it on every start.
  await repository.seedTemplate(SYSTEM_SUMMARY_TEMPLATE);

  const audio = new S3AudioSource({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    bucket: config.S3_BUCKET,
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
  });

  const transcription = new OpenAiTranscriptionClient({
    baseUrl: config.WHISPER_BASE_URL,
    model: config.WHISPER_MODEL,
    apiKey: config.WHISPER_API_KEY,
    timeoutMs: config.WHISPER_TIMEOUT_MS,
    vadFilter: config.WHISPER_VAD_FILTER,
  });

  const chat = new OpenAiChatClient({
    baseUrl: config.SUMMARY_BASE_URL,
    model: config.SUMMARY_MODEL,
    apiKey: config.SUMMARY_API_KEY,
    temperature: config.SUMMARY_TEMPERATURE,
    maxOutputTokens: config.SUMMARY_MAX_OUTPUT_TOKENS,
    timeoutMs: config.SUMMARY_TIMEOUT_MS,
    jsonMode: config.SUMMARY_JSON_MODE,
  });

  const metrics = createWorkerMetrics();
  const metricsServer = await startMetricsServer({
    metrics,
    port: config.WORKER_METRICS_PORT,
  });

  const boss = new PgBoss({ connectionString: config.DATABASE_URL });
  boss.on("error", (error: unknown) => {
    logQueueError(logger, error);
  });
  await boss.start();

  await startTranscribeWorker({
    boss,
    audio,
    transcription,
    repository,
    logger,
    language: config.WHISPER_LANGUAGE,
    // Chaining the summary onto a persisted transcript is what makes the core
    // path of CLAUDE.md ("recording → transcript → summary") run end to end
    // without anyone pressing a button.
    summaries: new PgBossSummaryEnqueuer(boss),
    summaryTemplateId: SYSTEM_SUMMARY_TEMPLATE.id,
    concurrency: config.WORKER_CONCURRENCY,
    metrics,
    retryLimit: config.WORKER_RETRY_LIMIT,
    retryDelaySeconds: config.WORKER_RETRY_DELAY_SECONDS,
    jobExpireSeconds: config.WORKER_JOB_EXPIRE_SECONDS,
  });

  await startSummarizeWorker({
    boss,
    chat,
    repository,
    logger,
    maxInputTokens: config.SUMMARY_MAX_INPUT_TOKENS,
    concurrency: config.SUMMARY_CONCURRENCY,
    metrics,
    retryLimit: config.WORKER_RETRY_LIMIT,
    retryDelaySeconds: config.WORKER_RETRY_DELAY_SECONDS,
    jobExpireSeconds: config.WORKER_JOB_EXPIRE_SECONDS,
  });

  logger.info(
    {
      event: "worker.started",
      whisperBaseUrl: config.WHISPER_BASE_URL,
      whisperModel: config.WHISPER_MODEL,
      // Worth one field in the startup line: it decides whether silence reaches
      // the model, which is visible in every transcript the worker produces.
      whisperVadFilter: config.WHISPER_VAD_FILTER,
      summaryBaseUrl: config.SUMMARY_BASE_URL,
      summaryModel: config.SUMMARY_MODEL,
      concurrency: config.WORKER_CONCURRENCY,
      summaryConcurrency: config.SUMMARY_CONCURRENCY,
      metricsPort: metricsServer.port,
    },
    "worker is consuming transcribe and summarize jobs",
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void (async () => {
        logger.info({ event: "worker.stopping", signal }, "shutting down");
        // Graceful: running jobs finish, nothing new is fetched.
        await boss.stop({ graceful: true });
        await metricsServer.close();
        await repository.close();
      })();
    });
  }
}

// Only run when executed directly, so importing the package in tests is free of
// side effects.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
