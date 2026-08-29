import { buildServer } from "./app.js";
import { loadConfig, resolveOidcConfig } from "./config.js";
import { createKeycloakJwks, createTokenVerifier } from "./auth/token-verifier.js";
import { HeaderRecordingContextProvider } from "./recording/context-provider.js";
import { JwtRecordingContextProvider } from "./recording/jwt-context-provider.js";
import { PgBossJobQueue } from "./recording/queue/pg-boss.js";
import { S3RecordingStorage } from "./recording/storage/s3.js";
import { PostgresMeetingStore } from "./meetings/repository.js";

export { buildServer } from "./app.js";
export type { BuildServerOptions } from "./app.js";
export {
  loadConfig,
  resolveOidcConfig,
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
export { InMemoryRecordingStorage } from "./recording/storage/memory.js";
export { PgBossJobQueue, TRANSCRIBE_QUEUE } from "./recording/queue/pg-boss.js";
export { InMemoryJobQueue } from "./recording/queue/memory.js";
export { HeaderRecordingContextProvider, UnauthorizedError } from "./recording/context-provider.js";
export { JwtRecordingContextProvider } from "./recording/jwt-context-provider.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const oidc = resolveOidcConfig(config);

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

  const meetings = new PostgresMeetingStore(config.DATABASE_URL);
  await meetings.migrate();

  const app = await buildServer({
    storage,
    queue,
    meetings,
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
    logger: { level: config.LOG_LEVEL },
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void (async () => {
        await app.close();
        await queue.stop();
        await meetings.close();
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
