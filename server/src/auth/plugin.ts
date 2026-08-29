import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { RequestContext } from "./context.js";
import { AuthError } from "./errors.js";
import { extractBearerToken } from "./token-verifier.js";
import type { TokenVerifier } from "./token-verifier.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Context of the acting user, or `undefined` on a route declared public. */
    auth: RequestContext | undefined;
    /**
     * Returns the request context, throwing if the route is public and therefore has none.
     * Handlers that touch data always go through this — it makes "unscoped query" a type error
     * rather than an oversight (ADR-001).
     */
    requireContext(this: FastifyRequest): RequestContext;
  }

  interface FastifyContextConfig {
    /**
     * Opt a route out of authentication. The plugin is default-deny: without this flag every
     * route requires a valid access token.
     */
    public?: boolean;
  }
}

export interface AuthPluginOptions {
  /** Verifier built by `createTokenVerifier`. Injected so tests can use a local key pair. */
  readonly verifyAccessToken: TokenVerifier;
}

function unauthorized(
  request: FastifyRequest,
  reply: FastifyReply,
  error: AuthError,
): FastifyReply {
  if (error.statusCode === 401) {
    reply.header("WWW-Authenticate", `Bearer error="invalid_token"`);
  }

  // A refused WebSocket upgrade is answered with a plain HTTP response on a socket that the
  // WebSocket plugin has already taken over, so nothing else will ever close it. Left alone it
  // keeps the process alive and stalls a graceful shutdown, hence the explicit teardown.
  if (typeof request.headers.upgrade === "string") {
    reply.header("Connection", "close");
    reply.raw.once("finish", () => {
      request.raw.socket.destroy();
    });
  }

  return reply.code(error.statusCode).send({
    error: error.code,
    message: error.message,
  });
}

const authPluginImpl: FastifyPluginAsync<AuthPluginOptions> = async (app, options) => {
  app.decorateRequest("auth", undefined);
  app.decorateRequest("requireContext", function (this: FastifyRequest): RequestContext {
    if (this.auth === undefined) {
      throw new AuthError(
        "missing_token",
        "This handler requires an authenticated, tenant-scoped request context.",
      );
    }
    return this.auth;
  });

  // Default-deny: authentication runs for every route unless it opts out via `config.public`.
  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.config.public === true) return;

    try {
      const token = extractBearerToken(request.headers.authorization);
      request.auth = await options.verifyAccessToken(token);
    } catch (error) {
      const authError =
        error instanceof AuthError
          ? error
          : new AuthError("invalid_token", "The access token could not be verified.");
      request.log.info(
        { code: authError.code, url: request.url },
        "rejected request without a valid access token",
      );
      return unauthorized(request, reply, authError);
    }

    // Every log line of an authenticated request carries the scope it ran under.
    request.log = request.log.child({
      userId: request.auth.userId,
      tenantId: request.auth.tenantId,
    });
  });
};

/** Validates Keycloak-issued access tokens and attaches a tenant-scoped context to the request. */
export const authPlugin = fp(authPluginImpl, {
  name: "quorum-auth",
  fastify: "5.x",
});
