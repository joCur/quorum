import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { authPlugin } from "./auth/plugin.js";
import type { IdentityVerifier, TokenVerifier } from "./auth/token-verifier.js";
import { ProvisioningError, type TenantProvisioner } from "./auth/provisioning.js";
import recordingPlugin from "./recording/plugin.js";
import { meetingRoutes } from "./meetings/routes.js";
import type { MeetingStore } from "./meetings/repository.js";
import { templateRoutes } from "./templates/routes.js";
import { summaryRoutes } from "./summaries/routes.js";
import { userSettingsRoutes } from "./settings/routes.js";
import type { SummaryTemplateStore } from "./templates/repository.js";
import type { UserSettingsStore } from "./settings/repository.js";
import { JwtRecordingContextProvider } from "./recording/jwt-context-provider.js";
import type { JobQueue, RecordingContextProvider, RecordingStorage } from "./recording/types.js";
import type { ServerMetrics } from "./observability/metrics.js";
import { LOGGER_BASE, LOGGER_FORMATTERS, LOGGER_TIMESTAMP } from "./observability/logging.js";
import type { UserLimitsResolver } from "./limits.js";
import { apiRateLimitPlugin } from "./api-rate-limit.js";

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
  /**
   * Per-user preferences behind `GET`/`PUT /api/settings`, and the source of the user-level
   * default the recording endpoint resolves a meeting's transcription language against.
   *
   * Omitting it leaves the routes off the instance and leaves the recording endpoint with the
   * per-meeting choice alone — which is the chain minus one link, not a broken one.
   */
  settings?: UserSettingsStore;
  auth?: { verifyAccessToken: TokenVerifier; verifyIdentity?: IdentityVerifier };
  /**
   * Gives a self-registered account its tenant on first use (see `auth/provisioning.ts`).
   *
   * Omitting it leaves `POST /api/me/tenant` off the instance entirely, which is what a deployment
   * without self-registration wants: the route exists only where there is something for it to do,
   * rather than existing and answering "not configured".
   */
  provisioning?: TenantProvisioner;
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
    await app.register(authPlugin, {
      verifyAccessToken: options.auth.verifyAccessToken,
      ...(options.auth.verifyIdentity ? { verifyIdentity: options.auth.verifyIdentity } : {}),
    });
    // After the auth plugin on purpose: both hook `onRequest` and run in registration order, so
    // the limiter already knows which user it is metering. An unverifiable token never reaches a
    // user bucket and is metered by IP instead.
    await app.register(apiRateLimitPlugin, {
      ...(options.limits ? { limits: options.limits } : {}),
    });
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

  const provisioning = options.provisioning;
  if (authenticated && provisioning) {
    // The one route a token with no tenant may reach. Everything about that is spelled out on
    // `tenantOptional` in `auth/plugin.ts`: the token is verified exactly as everywhere else, and
    // the handler gets an identity rather than a context, so it has no tenant to query under even
    // if someone later added a query to it.
    //
    // It is a POST because it writes, and it is idempotent because a client that retries — or two
    // devices signing in at the same moment — must not end up with two tenants.
    app.post("/api/me/tenant", { config: { tenantOptional: true } }, async (request, reply) => {
      const identity = request.requireIdentity();

      try {
        const tenantId = await provisioning.ensureTenant(identity.userId);
        request.log.info(
          { event: "auth.tenant_provisioned", userId: identity.userId, tenantId },
          "gave an account without a tenant its own",
        );
        // The caller's current token still carries no tenant — claims are minted at the provider,
        // not here. Saying so explicitly is what tells the client to renew before trying anything
        // else, instead of retrying a request that is guaranteed to fail for another five minutes.
        return { tenantId, tokenStale: true };
      } catch (error) {
        if (error instanceof ProvisioningError) {
          request.log.error(
            { event: "auth.tenant_provisioning_failed", userId: identity.userId, err: error },
            "could not give an account a tenant",
          );
          return reply.code(503).send({
            error: "provisioning_unavailable",
            message: "The account could not be set up right now. Try again in a moment.",
          });
        }
        throw error;
      }
    });
  }

  // Preferences belong to the signed-in user and to nobody else, so like every other scoped
  // route these exist only where a token has been validated.
  if (authenticated && options.settings) {
    await app.register(userSettingsRoutes, { store: options.settings });
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
    settings: options.settings,
    contextProvider: options.contextProvider ?? new JwtRecordingContextProvider(),
    publicUpgrade: options.allowUnauthenticatedRecording === true,
    ...(options.limits ? { limits: options.limits } : {}),
  });

  return app;
}
