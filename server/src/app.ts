import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { authPlugin } from "./auth/plugin.js";
import type { TokenVerifier } from "./auth/token-verifier.js";
import recordingPlugin from "./recording/plugin.js";
import { meetingRoutes } from "./meetings/routes.js";
import type { MeetingStore } from "./meetings/repository.js";
import { templateRoutes } from "./templates/routes.js";
import { summaryRoutes } from "./summaries/routes.js";
import type { SummaryTemplateStore } from "./templates/repository.js";
import { JwtRecordingContextProvider } from "./recording/jwt-context-provider.js";
import type { JobQueue, RecordingContextProvider, RecordingStorage } from "./recording/types.js";
import type { ServerMetrics } from "./observability/metrics.js";
import { LOGGER_BASE, LOGGER_FORMATTERS, LOGGER_TIMESTAMP } from "./observability/logging.js";
import type { UserLimitsResolver } from "./limits.js";
import { apiRateLimitPlugin } from "./api-rate-limit.js";
import betterAuthRoutes from "./auth/better-auth/routes.js";
import type { QuorumAuth } from "./auth/better-auth/instance.js";

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
  /**
   * Summary template store behind the template API and the regenerate action (ADR-004).
   *
   * Omitting it leaves those two endpoints off the instance entirely — the same rule `meetings`
   * follows. There is deliberately no in-memory default: a fallback store would answer requests
   * with an empty template list and no system template, which is a shape production never has,
   * and a test written against it would be testing a fiction.
   */
  templates?: SummaryTemplateStore;
  auth?: { verifyAccessToken: TokenVerifier };
  /**
   * SPIKE: the better-auth instance whose own endpoints (`/api/auth/*`) replace what the Keycloak
   * container served. Omitting it builds an instance that validates sessions but cannot create
   * them — which is what most unit tests want, since they mint sessions through the API object.
   */
  authEndpoints?: QuorumAuth;
  /**
   * Prometheus exposition served on `GET /metrics`, unauthenticated like `/healthz`. Omitting it
   * leaves the route off the instance entirely, which is what most unit tests want.
   */
  metrics?: ServerMetrics;
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
  /**
   * Where the recording endpoint looks up a user's abuse and cost limits. Defaults to the static
   * resolver over `DEFAULT_USER_LIMITS`, which sits far above any real recording — an
   * instance built without one is still protected.
   */
  limits?: UserLimitsResolver;
  logger?: boolean | { level: string };
}

/** Builds the Fastify application: auth foundation plus the WebSocket recording endpoint. */
export async function buildServer(options: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      typeof options.logger === "object"
        ? {
            level: options.logger.level,
            // Same shape as the worker's pino configuration, so one log query matches both
            // services (`docs/observability.md`).
            base: LOGGER_BASE,
            timestamp: LOGGER_TIMESTAMP,
            formatters: LOGGER_FORMATTERS,
          }
        : (options.logger ?? false),
  });

  const authenticated = options.auth !== undefined;
  if (options.auth !== undefined) {
    await app.register(authPlugin, { verifyAccessToken: options.auth.verifyAccessToken });
    // After the auth plugin on purpose: both hook `onRequest` and run in registration order, so
    // the limiter already knows which user it is metering. An unverifiable token never reaches a
    // user bucket and is metered by IP instead.
    await app.register(apiRateLimitPlugin, {
      ...(options.limits ? { limits: options.limits } : {}),
    });

    if (options.authEndpoints) {
      await app.register(betterAuthRoutes, { auth: options.authEndpoints });
    }
  }

  // Liveness/readiness probe for compose and the reverse proxy. Public on purpose: an
  // orchestrator has no token, and the response carries no tenant data.
  // `rateLimit: false`: an orchestrator polls this on a schedule and must never be throttled.
  app.get("/healthz", { config: { public: true, rateLimit: false } }, async () => ({
    status: "ok",
    service: "quorum-server",
  }));

  const metrics = options.metrics;
  if (metrics) {
    // Public for the same reason `/healthz` is: the scraper holds no access token. The payload is
    // queue depth and process counters — no tenant data and no meeting identifiers — but it still
    // belongs on the internal network only, which is why compose never publishes the API port
    // without a reverse proxy in front of it.
    app.get("/metrics", { config: { public: true } }, async (_request, reply) => {
      reply.header("content-type", metrics.contentType);
      return reply.send(await metrics.render());
    });
  }

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

  const meetingStore = options.meetings;
  if (authenticated && meetingStore) {
    // Read API for the meeting list and meeting detail. Every handler resolves its tenant and
    // user from the validated token, which is why the routes exist only on an authenticated
    // instance: without one there is no scope to query under, and an unscoped meeting query is
    // exactly what ADR-001 rules out.
    await app.register(meetingRoutes, { store: meetingStore, storage: options.storage });

    // Summary templates and the regenerate action share the same scoping rule and the same reason
    // for existing only on an authenticated instance: a template belongs to a user.
    if (options.templates) {
      await app.register(templateRoutes, { store: options.templates });
      await app.register(summaryRoutes, {
        meetings: meetingStore,
        templates: options.templates,
        queue: options.queue,
      });
    }
  }

  await app.register(recordingPlugin, {
    storage: options.storage,
    queue: options.queue,
    meetings: options.meetings,
    contextProvider: options.contextProvider ?? new JwtRecordingContextProvider(),
    publicUpgrade: options.allowUnauthenticatedRecording === true,
    ...(options.limits ? { limits: options.limits } : {}),
  });

  return app;
}
