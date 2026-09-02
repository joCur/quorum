import fastifyRateLimit, { type RateLimitOptions } from "@fastify/rate-limit";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import { StaticUserLimitsResolver, type UserLimitsResolver } from "./limits.js";

declare module "fastify" {
  interface FastifyInstance {
    /**
     * Route configuration for an endpoint that costs a model call, to be spread into the route's
     * `config.rateLimit`. It carries its own counter — see the note on buckets below.
     */
    expensiveRateLimit: RateLimitOptions;
  }
}

export interface ApiRateLimitOptions {
  /** Where a user's limits come from; defaults to the static resolver over the built-in defaults. */
  limits?: UserLimitsResolver;
}

/**
 * Per-user rate limiting for the REST API.
 *
 * The recording socket is metered per connection because that is where the audio arrives; the REST
 * API is metered **per user**, because a request there is cheap on its own and only becomes a
 * problem in volume — and because a per-connection budget would be free to reset by reconnecting.
 *
 * `@fastify/rate-limit` does the counting. Everything policy-like is ours:
 *
 * - The key is the tenant and user of the validated token, so one user cannot spend another's
 *   allowance and a shared IP (an office, a mobile carrier) is not one bucket. Only a public route
 *   with no context falls back to the IP, which for now is just `/healthz` — and that one is
 *   exempt anyway.
 * - The numbers come from the per-user limits resolver, per request, so a plan tier changes them
 *   without touching this file.
 * - A route that buys pipeline work declares `config: { rateLimit: app.expensiveRateLimit }` and
 *   is then metered against the much smaller allowance. Two routes are of that kind today —
 *   regenerating a summary, which buys a model call, and retrying a transcription, which buys GPU
 *   time — while the rest of the API reads rows the pipeline has already produced.
 *
 * - Exceeding the limit answers `429` with the machine-readable `limit.request_rate_exceeded`
 *   code, like every other limit in this system, so the client renders the text through i18n.
 *
 * ONE BUCKET PER ALLOWANCE, WHICH IS THE WHOLE POINT: `@fastify/rate-limit` keeps a single counter
 * per key for every route that has no `config.rateLimit` of its own, and every route-level config
 * object gets a counter of its own. Deriving a smaller `max` for an expensive route from the
 * shared counter would not give it a smaller allowance — it would refuse it as soon as the user's
 * ordinary browsing had spent ten requests of any kind. Reading a meeting list must not use up the
 * right to ask for a summary, so an expensive route gets its own counter instead of a lower
 * ceiling on everyone else's.
 */
const apiRateLimitImpl: FastifyPluginAsync<ApiRateLimitOptions> = async (app, options) => {
  const resolver = options.limits ?? new StaticUserLimitsResolver();

  await app.register(fastifyRateLimit, {
    global: true,
    keyGenerator: bucketKey,
    max: async (request: FastifyRequest) =>
      (await resolver.resolve(scopeOf(request))).apiRequestsPerWindow,
    timeWindow: async (request: FastifyRequest) =>
      (await resolver.resolve(scopeOf(request))).apiWindowSeconds * 1000,
    // The builder's return value is *thrown* by the plugin, so it has to be an error. The error
    // handler below turns it into the `{ error, message }` body the rest of this API uses; a plain
    // object here would surface as a 500.
    errorResponseBuilder: () => new RateLimitExceededError(),
  });

  // The counter for model-call routes. Same key and the same resolver, a separate tally.
  app.decorate("expensiveRateLimit", {
    keyGenerator: expensiveKey,
    max: async (request: FastifyRequest) =>
      (await resolver.resolve(scopeOf(request))).apiSummaryRequestsPerWindow,
    timeWindow: async (request: FastifyRequest) =>
      (await resolver.resolve(scopeOf(request))).apiWindowSeconds * 1000,
    errorResponseBuilder: () => new RateLimitExceededError(),
  } satisfies RateLimitOptions);

  // Narrow on purpose: anything that is not the limiter's own error is handed straight back to
  // Fastify's default handling, so installing this does not change how any other failure is
  // reported.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RateLimitExceededError) {
      return reply.code(429).send({
        error: "limit.request_rate_exceeded",
        message: "Too many requests. Try again shortly.",
      });
    }
    return reply.send(error);
  });
};

/**
 * Thrown by the limiter and recognized by the error handler above. A dedicated class rather than a
 * status-code check, so no other 429 in this codebase can be mistaken for a rate-limit refusal.
 */
class RateLimitExceededError extends Error {
  readonly statusCode = 429;

  constructor() {
    super("The per-user request rate limit was exceeded.");
    this.name = "RateLimitExceededError";
  }
}

/**
 * The bucket key: the acting user, or the address when there is no validated token at all.
 *
 * A caller whose token is valid but carries no tenant yet, a freshly registered account on its way
 * to the provisioning route, is metered under its own subject rather than its address. Otherwise
 * an office behind one NAT would share a single bucket for everybody's first sign-in.
 */
function bucketKey(request: FastifyRequest): string {
  const context = request.auth;
  if (context) return `${context.tenantId} ${context.userId}`;
  const identity = request.identity;
  if (identity) return `unprovisioned ${identity.userId}`;
  return `ip:${request.ip}`;
}

/** The key for the separate counter the model-call routes are metered against. */
function expensiveKey(request: FastifyRequest): string {
  return bucketKey(request);
}

/**
 * The scope a request is metered under. An unauthenticated request has no tenant, and resolving
 * limits for it is meaningless — it gets the default tier, which is all the V1 resolver has.
 */
function scopeOf(request: FastifyRequest): { tenantId: string; userId: string } {
  return {
    tenantId: request.auth?.tenantId ?? "",
    userId: request.auth?.userId ?? "",
  };
}

export const apiRateLimitPlugin = fp(apiRateLimitImpl, {
  name: "quorum-api-rate-limit",
  fastify: "5.x",
});
