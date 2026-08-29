import { buildServer } from "./app.js";
import { loadConfig } from "./config.js";
import { HeaderRecordingContextProvider } from "./recording/context-provider.js";
import { PgBossJobQueue } from "./recording/queue/pg-boss.js";
import { S3RecordingStorage } from "./recording/storage/s3.js";

export { buildServer } from "./app.js";
export { loadConfig, ServerConfigSchema, type ServerConfig } from "./config.js";
export * from "./recording/types.js";
export * from "./recording/keys.js";
export * from "./recording/frame.js";
export * from "./recording/audio-format.js";
export * from "./recording/session.js";
export { default as recordingPlugin } from "./recording/plugin.js";
export { S3RecordingStorage } from "./recording/storage/s3.js";
export { InMemoryRecordingStorage } from "./recording/storage/memory.js";
export { PgBossJobQueue, TRANSCRIBE_QUEUE } from "./recording/queue/pg-boss.js";
export { InMemoryJobQueue } from "./recording/queue/memory.js";
export { HeaderRecordingContextProvider, UnauthorizedError } from "./recording/context-provider.js";

async function main(): Promise<void> {
  const config = loadConfig();

  const storage = new S3RecordingStorage({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    bucket: config.S3_BUCKET,
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
    serverSideEncryption: config.S3_SSE,
  });

  const queue = new PgBossJobQueue(config.DATABASE_URL);
  await queue.start();

  const app = await buildServer({
    storage,
    queue,
    contextProvider: new HeaderRecordingContextProvider(config.RECORDING_ALLOW_HEADER_AUTH),
    logger: { level: config.LOG_LEVEL },
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void (async () => {
        await app.close();
        await queue.stop();
      })();
    });
  }

  await app.listen({ port: config.PORT, host: config.HOST });
}

// Only run when executed directly, so importing the package in tests is free of
// side effects.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
