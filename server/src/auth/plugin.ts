import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import fp from "fastify-plugin";
import type { RequestContext } from "./context.js";
import { AuthError } from "./errors.js";
import { extractSubprotocolToken, offersBearerSubprotocol } from "./subprotocol.js";
import { extractBearerToken } from "./token-verifier.js";
import type { IdentityVerifier, TokenIdentity, TokenVerifier } from "./token-verifier.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Context of the acting user, or `undefined` on a route declared public. */
    auth: RequestContext | undefined;
    /**
     * Who the caller is, when that is known but their tenant is not. Set only on a route that
     * declared `tenantOptional`, and only for a token that passed every check but the tenant.
     */
    identity: TokenIdentity | undefined;
    /**
     * Returns the request context, throwing if the route is public and therefore has none.
     * Handlers that touch data always go through this — it makes "unscoped query" a type error
     * rather than an oversight (ADR-001).
     */
    requireContext(this: FastifyRequest): RequestContext;
    /** Returns the caller's identity, throwing when the request carries no verified token. */
    requireIdentity(this: FastifyRequest): TokenIdentity;
  }

  interface FastifyContextConfig {
    /**
     * Opt a route out of authentication. The plugin is default-deny: without this flag every
     * route requires a valid access token.
     */
    public?: boolean;
    /**
     * Let a route run for a caller whose token is entirely valid but carries no tenant.
     *
     * This is not an opt-out of authentication, and it is not an opt-out of scoping. The token is
     * verified exactly as it is everywhere else; what changes is that `request.auth` stays
     * `undefined` and only `request.identity` is set. Every handler that reads or writes data
     * goes through `requireContext()`, which throws on an undefined context — so a route flagged
     * here cannot reach tenant data even by mistake, because there is no tenant to reach it under.
     *
     * Exactly one route uses it: the one that gives a freshly registered account its tenant.
     */
    tenantOptional?: boolean;
  }
}

export interface AuthPluginOptions {
  /** Verifier built by `createTokenVerifiers`. Injected so tests can use a local key pair. */
  readonly verifyAccessToken: TokenVerifier;
  /**
   * The tenant-less verifier from the same factory. Without it a `tenantOptional` route behaves
   * like every other route: a token carrying no tenant is refused with 403.
   */
  readonly verifyIdentity?: IdentityVerifier;
}

/**
 * Reads the raw access token from the request.
 *
 * The `Authorization` header stays the primary and preferred channel and is used whenever it is
 * present. A browser cannot set that header on a WebSocket upgrade, so an upgrade request may
 * instead carry the token in the `quorum.bearer.v1` subprotocol; both channels then run through
 * exactly the same verification.
 */
function readAccessToken(request: FastifyRequest): string {
  if (request.headers.authorization !== undefined) {
    return extractBearerToken(request.headers.authorization);
  }

  const offered = request.headers["sec-websocket-protocol"];
  if (typeof request.headers.upgrade === "string" && offersBearerSubprotocol(offered)) {
    return extractSubprotocolToken(offered);
  }

  return extractBearerToken(undefined);
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
  app.decorateRequest("identity", undefined);
  app.decorateRequest("requireContext", function (this: FastifyRequest): RequestContext {
    if (this.auth === undefined) {
      throw new AuthError(
        "missing_token",
        "This handler requires an authenticated, tenant-scoped request context.",
      );
    }
    return this.auth;
  });
  app.decorateRequest("requireIdentity", function (this: FastifyRequest): TokenIdentity {
    if (this.identity === undefined) {
      throw new AuthError("missing_token", "This handler requires a verified access token.");
    }
    return this.identity;
  });

  // Default-deny: authentication runs for every route unless it opts out via `config.public`.
  app.addHook("onRequest", async (request, reply) => {
    if (request.routeOptions.config.public === true) return;

    // Kept outside the try so the tenant-less branch below can reuse the token it verified. It
    // stays `undefined` when reading the token itself failed, which is a different rejection.
    let token: string | undefined;

    try {
      token = readAccessToken(request);
      request.auth = await options.verifyAccessToken(token);
      request.identity = {
        userId: request.auth.userId,
        roles: request.auth.roles,
        username: request.auth.username,
        email: request.auth.email,
        // Not carried by RequestContext, and no handler that has a tenant needs it.
        emailVerified: true,
      };
    } catch (error) {
      // A token that is valid in every other respect but carries no tenant is what a freshly
      // registered account holds. On the one route that exists to fix that, the caller is let
      // through as an identity with no context; everywhere else this stays a 403.
      if (
        error instanceof AuthError &&
        error.code === "missing_tenant" &&
        request.routeOptions.config.tenantOptional === true &&
        options.verifyIdentity !== undefined &&
        token !== undefined
      ) {
        request.identity = await options.verifyIdentity(token);
        request.log = request.log.child({ userId: request.identity.userId });
        return;
      }

      const authError =
        error instanceof AuthError
          ? error
          : new AuthError("invalid_token", "The access token could not be verified.");
      request.log.info(
        { event: "auth.rejected", code: authError.code, url: request.url },
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
