import Fastify from "fastify";
import type { FastifyInstance } from "fastify";
import { authPlugin } from "./auth/plugin.js";
import { createKeycloakJwks, createTokenVerifier } from "./auth/token-verifier.js";
import type { TokenVerifier } from "./auth/token-verifier.js";
import type { ServerConfig } from "./config.js";

export interface BuildAppOptions {
  readonly config: ServerConfig;
  /**
   * Overrides token verification. Tests inject a verifier backed by a locally generated key pair;
   * production leaves this out and the remote JWKS of the configured issuer is used.
   */
  readonly verifyAccessToken?: TokenVerifier;
}

/**
 * Builds the Fastify application.
 *
 * The auth plugin is default-deny, so every route added here needs a valid Keycloak access token
 * unless it is explicitly declared `config: { public: true }`.
 */
export async function buildApp(options: BuildAppOptions): Promise<FastifyInstance> {
  const { config } = options;

  const app = Fastify({
    logger: { level: config.logLevel },
  });

  const verifyAccessToken =
    options.verifyAccessToken ??
    createTokenVerifier({
      issuers: config.oidc.acceptedIssuers,
      audience: config.oidc.audience,
      tenantClaim: config.oidc.tenantClaim,
      keySource: createKeycloakJwks(config.oidc.issuer, config.oidc.jwksUri),
    });

  await app.register(authPlugin, { verifyAccessToken });

  // Liveness/readiness probe for compose and the reverse proxy. Public on purpose: an orchestrator
  // has no token, and the response carries no tenant data.
  app.get("/healthz", { config: { public: true } }, async () => ({
    status: "ok",
    service: "quorum-server",
  }));

  // Smallest possible protected route: proves that a token was validated and shows the scope the
  // request runs under. Replaced by real resources in the follow-up tickets.
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

  return app;
}
