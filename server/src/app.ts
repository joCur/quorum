import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { authPlugin } from "./auth/plugin.js";
import type { TokenVerifier } from "./auth/token-verifier.js";
import recordingPlugin from "./recording/plugin.js";
import { meetingRoutes } from "./meetings/routes.js";
import type { MeetingStore } from "./meetings/repository.js";
import { JwtRecordingContextProvider } from "./recording/jwt-context-provider.js";
import type { JobQueue, RecordingContextProvider, RecordingStorage } from "./recording/types.js";

export interface BuildServerOptions {
  storage: RecordingStorage;
  queue: JobQueue;
  /**
   * Meeting index behind the recording endpoint and the meeting REST API. Omitting it builds an
   * instance that records but lists nothing — only useful for the recording-only tests.
   */
  meetings?: MeetingStore;
  /**
   * Enables authentication. When present, the auth plugin is registered and the whole instance
   * becomes default-deny: every route needs a valid Keycloak access token unless it declares
   * `config: { public: true }`. The WebSocket upgrade goes through the same hook.
   *
   * Omitting it builds an unauthenticated instance — only for tests and for the header-based
   * development path, which then has to supply an explicit `contextProvider`.
   */
  auth?: { verifyAccessToken: TokenVerifier };
  /**
   * Source of the recording tenant/user scope. Defaults to the validated access token; pass the
   * development header provider (or a stub) to override.
   */
  contextProvider?: RecordingContextProvider;
  /**
   * Development-only gate: exempts the recording upgrade from default-deny so the header context
   * provider can supply the scope without an access token. Never set in production.
   */
  allowUnauthenticatedRecording?: boolean;
  logger?: boolean | { level: string };
}

/** Builds the Fastify application: auth foundation plus the WebSocket recording endpoint. */
export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: options.logger ?? false });

  const authenticated = options.auth !== undefined;
  if (options.auth !== undefined) {
    await app.register(authPlugin, { verifyAccessToken: options.auth.verifyAccessToken });
  }

  // Liveness/readiness probe for compose and the reverse proxy. Public on purpose: an
  // orchestrator has no token, and the response carries no tenant data.
  app.get("/healthz", { config: { public: true } }, async () => ({
    status: "ok",
    service: "quorum-server",
  }));

  if (authenticated) {
    // Smallest possible protected route: proves that a token was validated and shows the scope
    // the request runs under. Only exists on an authenticated instance.
    app.get("/api/me", async (request) => {
      const context = request.requireContext();
      return {
        userId: context.userId,
        tenantId: context.tenantId,
        roles: context.roles,
        username: context.username,
        email: context.email,
      };
    });
  }

  if (authenticated && options.meetings) {
    // Read API for the meeting list and meeting detail. Every handler resolves its tenant and
    // user from the validated token, which is why the routes exist only on an authenticated
    // instance: without one there is no scope to query under, and an unscoped meeting query is
    // exactly what ADR-001 rules out.
    await app.register(meetingRoutes, { store: options.meetings, storage: options.storage });
  }

  await app.register(recordingPlugin, {
    storage: options.storage,
    queue: options.queue,
    meetings: options.meetings,
    contextProvider: options.contextProvider ?? new JwtRecordingContextProvider(),
    publicUpgrade: options.allowUnauthenticatedRecording === true,
  });

  return app;
}
