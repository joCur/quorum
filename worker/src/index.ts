import { PgBoss } from "pg-boss";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { PostgresTranscriptRepository } from "./db/repository.js";
import { S3AudioSource } from "./storage/audio-source.js";
import { OpenAiTranscriptionClient } from "./whisper/client.js";
import { startTranscribeWorker } from "./worker.js";

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
  PostgresTranscriptRepository,
  type TranscriptRepository,
  type SaveTranscriptResult,
  type JobScope,
} from "./db/repository.js";
export {
  runTranscribeJob,
  type TranscribeHandlerDependencies,
  type TranscribeOutcome,
} from "./handler.js";
export { startTranscribeWorker, type TranscribeWorkerOptions } from "./worker.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);

  const repository = new PostgresTranscriptRepository(config.DATABASE_URL);
  await repository.migrate();

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
  });

  const boss = new PgBoss({ connectionString: config.DATABASE_URL });
  boss.on("error", (error: unknown) => logger.error({ err: error }, "pg-boss error"));
  await boss.start();

  await startTranscribeWorker({
    boss,
    audio,
    transcription,
    repository,
    logger,
    language: config.WHISPER_LANGUAGE,
    concurrency: config.WORKER_CONCURRENCY,
    retryLimit: config.WORKER_RETRY_LIMIT,
    retryDelaySeconds: config.WORKER_RETRY_DELAY_SECONDS,
    jobExpireSeconds: config.WORKER_JOB_EXPIRE_SECONDS,
  });

  logger.info(
    {
      event: "worker.started",
      whisperBaseUrl: config.WHISPER_BASE_URL,
      whisperModel: config.WHISPER_MODEL,
      concurrency: config.WORKER_CONCURRENCY,
    },
    "transcription worker is consuming jobs",
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void (async () => {
        logger.info({ event: "worker.stopping", signal }, "shutting down");
        // Graceful: running jobs finish, nothing new is fetched.
        await boss.stop({ graceful: true });
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
