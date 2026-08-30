import { buildServer } from "./app.js";
import { loadConfig, resolveOidcConfig, resolveUserLimits } from "./config.js";
import { createKeycloakJwks, createTokenVerifier } from "./auth/token-verifier.js";
import { HeaderRecordingContextProvider } from "./recording/context-provider.js";
import { JwtRecordingContextProvider } from "./recording/jwt-context-provider.js";
import { PgBossJobQueue, createPendingJobCounter } from "./recording/queue/pg-boss.js";
import { S3RecordingStorage } from "./recording/storage/s3.js";
import { PostgresMeetingStore } from "./meetings/repository.js";
import { PostgresSummaryTemplateStore } from "./templates/repository.js";
import { StaticUserLimitsResolver } from "./limits.js";
import { createServerMetrics } from "./observability/metrics.js";
import { PostgresQueueSnapshot } from "./observability/queue-snapshot.js";

export { buildServer } from "./app.js";
export type { BuildServerOptions } from "./app.js";
export {
  loadConfig,
  resolveOidcConfig,
  resolveUserLimits,
  ServerConfigSchema,
  type OidcConfig,
  type ServerConfig,
} from "./config.js";
export { authPlugin } from "./auth/plugin.js";
export type { AuthPluginOptions } from "./auth/plugin.js";
export { hasRole } from "./auth/context.js";
export type { RequestContext } from "./auth/context.js";
export { AuthError } from "./auth/errors.js";
export type { AuthErrorCode } from "./auth/errors.js";
export {
  createKeycloakJwks,
  createTokenVerifier,
  extractBearerToken,
  keycloakJwksUri,
} from "./auth/token-verifier.js";
export type { TokenVerifier, TokenVerifierOptions } from "./auth/token-verifier.js";
export * from "./recording/types.js";
export * from "./recording/keys.js";
export * from "./recording/frame.js";
export * from "./recording/audio-format.js";
export * from "./recording/session.js";
export * from "./limits.js";
export * from "./recording/limits.js";
export { default as recordingPlugin } from "./recording/plugin.js";
export { S3RecordingStorage } from "./recording/storage/s3.js";
export * from "./meetings/status.js";
export {
  PostgresMeetingStore,
  DEFAULT_MEETING_LIMIT,
  MAX_MEETING_LIMIT,
  escapeLike,
} from "./meetings/repository.js";
export type {
  ListMeetingsOptions,
  MeetingDetailRow,
  MeetingRecord,
  MeetingScope,
  MeetingStore,
} from "./meetings/repository.js";
export { InMemoryMeetingStore } from "./meetings/memory.js";
export { MEETING_MIGRATIONS } from "./meetings/schema.js";
export { meetingRoutes } from "./meetings/routes.js";
export { templateRoutes } from "./templates/routes.js";
export { summaryRoutes } from "./summaries/routes.js";
export {
  PostgresSummaryTemplateStore,
  TemplatesUnavailableError,
  templateFromDraft,
} from "./templates/repository.js";
export type { SummaryTemplateStore, TemplateScope } from "./templates/repository.js";
export { InMemorySummaryTemplateStore } from "./templates/memory.js";
export { InMemoryRecordingStorage } from "./recording/storage/memory.js";
export {
  PgBossJobQueue,
  createPendingJobCounter,
  TRANSCRIBE_QUEUE,
  SUMMARIZE_QUEUE,
  type PendingJobCounter,
} from "./recording/queue/pg-boss.js";
export * from "./recording/queue/fairness.js";
export { apiRateLimitPlugin } from "./api-rate-limit.js";
export { InMemoryJobQueue } from "./recording/queue/memory.js";
export { HeaderRecordingContextProvider, UnauthorizedError } from "./recording/context-provider.js";
export { JwtRecordingContextProvider } from "./recording/jwt-context-provider.js";
export * from "./observability/metrics.js";
export * from "./observability/logging.js";
export { PostgresQueueSnapshot } from "./observability/queue-snapshot.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const oidc = resolveOidcConfig(config);
  // V1 has no plan tiers, so every user resolves to the same environment-configured limits.
  const limits = new StaticUserLimitsResolver(resolveUserLimits(config));

  const storage = new S3RecordingStorage({
    endpoint: config.S3_ENDPOINT,
    region: config.S3_REGION,
    bucket: config.S3_BUCKET,
    accessKeyId: config.S3_ACCESS_KEY,
    secretAccessKey: config.S3_SECRET_KEY,
    serverSideEncryption: config.S3_SSE,
  });

  // The counter is what makes the queue fair: a user's next job ranks behind the ones they are
  // already waiting on, so nobody can monopolize the GPU workers.
  const queue = new PgBossJobQueue(
    config.DATABASE_URL,
    createPendingJobCounter(config.DATABASE_URL),
  );
  await queue.start();

  const meetings = new PostgresMeetingStore(config.DATABASE_URL);
  await meetings.migrate();

  // No migration call: `summary_templates` is created and seeded by the worker, which needs the
  // system template before it can summarize anything. The API reads and writes rows in it but is
  // not its migration owner — see the note in `templates/repository.ts`.
  const templates = new PostgresSummaryTemplateStore(config.DATABASE_URL);

  // Queue depth is reported by the API rather than the worker: a crashed worker is precisely the
  // case the backlog alert has to survive, and a gauge that dies with its process cannot.
  const queueSnapshot = new PostgresQueueSnapshot(config.DATABASE_URL);
  const metrics = createServerMetrics({ queues: queueSnapshot });

  const app = await buildServer({
    storage,
    queue,
    metrics,
    meetings,
    templates,
    auth: {
      verifyAccessToken: createTokenVerifier({
        issuers: oidc.acceptedIssuers,
        audience: oidc.audience,
        tenantClaim: oidc.tenantClaim,
        keySource: createKeycloakJwks(oidc.issuer, oidc.jwksUri),
      }),
    },
    // The header provider stays reachable only behind its explicit development gate; everywhere
    // else the recording scope comes from the validated access token.
    contextProvider: config.RECORDING_ALLOW_HEADER_AUTH
      ? new HeaderRecordingContextProvider(true)
      : new JwtRecordingContextProvider(),
    allowUnauthenticatedRecording: config.RECORDING_ALLOW_HEADER_AUTH,
    limits,
    logger: { level: config.LOG_LEVEL },
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void (async () => {
        await app.close();
        await queue.stop();
        await meetings.close();
        await templates.close();
        await queueSnapshot.close();
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
