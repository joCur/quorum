import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { JWTPayload, JWTVerifyGetKey } from "jose";
import type { RequestContext } from "./context.js";
import { AuthError } from "./errors.js";

/** Options for {@link createTokenVerifier}. */
export interface TokenVerifierOptions {
  /**
   * Issuers accepted in the `iss` claim. Two entries are normal in the compose stack: the
   * container-internal issuer and the public one the browser is redirected to (ADR-006 §7).
   */
  readonly issuers: readonly string[];
  /** Audience the access token must carry — the `quorum-api` audience added by the client scope. */
  readonly audience: string;
  /** Claim carrying the tenant identifier. Defaults to `tenant_id`. */
  readonly tenantClaim?: string;
  /** Signature algorithms accepted. Defaults to RS256, matching the realm configuration. */
  readonly algorithms?: readonly string[];
  /** Clock skew tolerance in seconds. Defaults to 5. */
  readonly clockToleranceSeconds?: number;
  /**
   * Key source. Production passes a remote JWKS (see {@link createKeycloakJwks}); tests pass a
   * local key set built from a generated key pair, which keeps them offline.
   */
  readonly keySource: JWTVerifyGetKey;
}

/** Verifies a raw bearer token and produces the tenant-scoped request context. */
export type TokenVerifier = (token: string) => Promise<RequestContext>;

/**
 * Who the caller is, without a tenant.
 *
 * This exists for exactly one situation: a freshly registered account whose token carries no tenant
 * yet, asking to be given one. It is deliberately a separate type rather than a
 * {@link RequestContext} with an optional `tenantId`, because an optional field is something a
 * handler can forget to check, and a query scoped by `undefined` is the failure ADR-001 exists to
 * make impossible. Nothing that reads or writes data accepts this type.
 */
export interface TokenIdentity {
  /** Stable subject identifier from the token (`sub`). */
  readonly userId: string;
  /** Realm roles granted to the user. */
  readonly roles: readonly string[];
  readonly username: string | undefined;
  readonly email: string | undefined;
  /** Whether the provider considers the address verified. */
  readonly emailVerified: boolean;
}

/** Verifies a raw bearer token and produces the caller's identity, with or without a tenant. */
export type IdentityVerifier = (token: string) => Promise<TokenIdentity>;

/** Builds the JWKS endpoint of a Keycloak realm from its issuer URL. */
export function keycloakJwksUri(issuer: string): string {
  return `${issuer.replace(/\/+$/, "")}/protocol/openid-connect/certs`;
}

/**
 * Remote JWKS with the caching and cooldown behavior of `jose` — keys are fetched lazily on the
 * first token and refetched only when an unknown `kid` shows up, so key rotation needs no restart.
 */
export function createKeycloakJwks(issuer: string, jwksUri?: string): JWTVerifyGetKey {
  return createRemoteJWKSet(new URL(jwksUri ?? keycloakJwksUri(issuer)));
}

interface KeycloakAccessToken extends JWTPayload {
  readonly preferred_username?: unknown;
  readonly email?: unknown;
  readonly email_verified?: unknown;
  readonly realm_access?: { readonly roles?: unknown };
}

function readStringClaim(payload: JWTPayload, claim: string): string | undefined {
  const value = (payload as Record<string, unknown>)[claim];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readRealmRoles(payload: KeycloakAccessToken): readonly string[] {
  const roles = payload.realm_access?.roles;
  if (!Array.isArray(roles)) return [];
  return roles.filter((role): role is string => typeof role === "string");
}

/**
 * Translates a `jose` verification failure into an {@link AuthError} with a stable code, so the
 * API never leaks library internals and the client can map the reason through i18n.
 */
function toAuthError(error: unknown): AuthError {
  if (error instanceof errors.JWTExpired) {
    return new AuthError("expired_token", "The access token has expired.");
  }
  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === "iss") {
      return new AuthError("invalid_issuer", "The access token was issued by an unknown issuer.");
    }
    if (error.claim === "aud") {
      return new AuthError("invalid_audience", "The access token is not intended for this API.");
    }
  }
  return new AuthError("invalid_token", "The access token could not be verified.");
}

/**
 * The two verifiers built over one signature check.
 *
 * They are produced together rather than independently so that there is exactly one place where a
 * token's signature, issuer, audience and expiry are decided. A second, separately written
 * verifier is how the strict path and the lenient one drift apart, and the lenient one is the one
 * an unprovisioned account reaches.
 */
export interface TokenVerifiers {
  /** The strict verifier: a tenant is mandatory, and everything that touches data uses this. */
  readonly verifyAccessToken: TokenVerifier;
  /** The same checks minus the tenant. Only the tenant-provisioning route uses it. */
  readonly verifyIdentity: IdentityVerifier;
}

export function createTokenVerifiers(options: TokenVerifierOptions): TokenVerifiers {
  const tenantClaim = options.tenantClaim ?? "tenant_id";
  const issuers = [...options.issuers];
  if (issuers.length === 0) {
    throw new Error("createTokenVerifier requires at least one accepted issuer.");
  }

  async function verify(token: string): Promise<KeycloakAccessToken> {
    if (token.length === 0) {
      throw new AuthError("missing_token", "No access token was provided.");
    }
    try {
      const result = await jwtVerify<KeycloakAccessToken>(token, options.keySource, {
        issuer: issuers,
        audience: options.audience,
        algorithms: [...(options.algorithms ?? ["RS256"])],
        clockTolerance: options.clockToleranceSeconds ?? 5,
      });
      return result.payload;
    } catch (error) {
      throw toAuthError(error);
    }
  }

  function subjectOf(payload: KeycloakAccessToken): string {
    const userId = readStringClaim(payload, "sub");
    if (userId === undefined) {
      throw new AuthError("missing_subject", "The access token carries no subject.");
    }
    return userId;
  }

  async function verifyIdentity(token: string): Promise<TokenIdentity> {
    const payload = await verify(token);
    return {
      userId: subjectOf(payload),
      roles: readRealmRoles(payload),
      username: readStringClaim(payload, "preferred_username"),
      email: readStringClaim(payload, "email"),
      emailVerified: payload.email_verified === true,
    };
  }

  async function verifyAccessToken(token: string): Promise<RequestContext> {
    const payload = await verify(token);
    const userId = subjectOf(payload);

    // ADR-001: without a tenant we cannot scope a single query, so the request is rejected
    // rather than silently falling back to something global.
    const tenantId = readStringClaim(payload, tenantClaim);
    if (tenantId === undefined) {
      throw new AuthError(
        "missing_tenant",
        `The access token carries no "${tenantClaim}" claim; the request cannot be tenant-scoped.`,
        403,
      );
    }

    return {
      userId,
      tenantId,
      roles: readRealmRoles(payload),
      username: readStringClaim(payload, "preferred_username"),
      email: readStringClaim(payload, "email"),
      issuer: payload.iss ?? issuers[0]!,
      expiresAt: payload.exp ?? 0,
    };
  }

  return { verifyAccessToken, verifyIdentity };
}

/** The strict verifier on its own — the one almost every caller wants. */
export function createTokenVerifier(options: TokenVerifierOptions): TokenVerifier {
  return createTokenVerifiers(options).verifyAccessToken;
}

/** Extracts the raw token from an `Authorization: Bearer <token>` header. */
export function extractBearerToken(header: string | undefined): string {
  if (header === undefined || header.length === 0) {
    throw new AuthError("missing_token", "The Authorization header is missing.");
  }
  const match = /^Bearer[ ]+(?<token>[^\s]+)$/i.exec(header);
  const token = match?.groups?.["token"];
  if (token === undefined) {
    throw new AuthError(
      "malformed_authorization_header",
      "The Authorization header must be of the form 'Bearer <token>'.",
    );
  }
  return token;
}
