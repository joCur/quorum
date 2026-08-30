import type { RequestContext } from "../context.js";
import { AuthError } from "../errors.js";
import type { TokenVerifier } from "../token-verifier.js";
import type { QuorumAuth } from "./instance.js";

/**
 * Turns a better-auth session token into the same {@link RequestContext} the Keycloak verifier
 * produced.
 *
 * THE POINT OF THIS FILE: it has the signature of `TokenVerifier`, so `auth/plugin.ts`, the
 * default-deny hook, the subprotocol reader, the recording context provider, the rate limiter and
 * every route handler are untouched by the swap. The whole server-side migration is "build a
 * different verifier in `index.ts`".
 *
 * THE HONEST DIFFERENCE: the Keycloak verifier is a signature check on a self-contained token —
 * no I/O after the first JWKS fetch. This one is a database read per request. That buys instant
 * revocation (a deleted session stops working on the next request instead of at token expiry) and
 * costs one indexed lookup per request, plus a hard dependency of *authentication* on Postgres.
 */
export function createSessionVerifier(auth: QuorumAuth): TokenVerifier {
  return async function verifySessionToken(token: string): Promise<RequestContext> {
    if (token.length === 0) {
      throw new AuthError("missing_token", "No session token was provided.");
    }

    // The bearer plugin reads the token off this header and resolves it exactly as it would a
    // session cookie, so the header and cookie paths cannot drift apart.
    const headers = new Headers({ authorization: `Bearer ${token}` });

    let result: Awaited<ReturnType<QuorumAuth["api"]["getSession"]>>;
    try {
      result = await auth.api.getSession({ headers });
    } catch {
      throw new AuthError("invalid_token", "The session token could not be verified.");
    }

    if (result === null) {
      // better-auth answers `null` for an unknown, tampered *and* expired session alike, so the
      // API can no longer tell the client "expired" from "invalid". The client treats both the
      // same way (renew, then sign in), but the distinction is genuinely lost — see the report.
      throw new AuthError("invalid_token", "The session token is unknown or no longer valid.");
    }

    const { session, user } = result;
    const expiresAt = Math.floor(new Date(session.expiresAt).getTime() / 1000);
    if (Number.isFinite(expiresAt) && expiresAt * 1000 <= Date.now()) {
      throw new AuthError("expired_token", "The session has expired.");
    }

    const tenantId = readString((user as Record<string, unknown>)["tenantId"]);
    if (tenantId === undefined) {
      // ADR-001: same rule, same status code, same error body as before — a user row without a
      // tenant cannot scope a single query.
      throw new AuthError(
        "missing_tenant",
        "The session carries no tenant; the request cannot be tenant-scoped.",
        403,
      );
    }

    return {
      userId: user.id,
      tenantId,
      roles: readRoles((user as Record<string, unknown>)["roles"]),
      username: readString(user.name) ?? readString(user.email),
      email: readString(user.email),
      // No issuer in the OIDC sense any more: the API is its own authority. Kept in the context
      // because the type is shared with the recording plugin and the logs.
      issuer: "quorum",
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : 0,
    };
  };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Roles are a comma-separated column rather than Keycloak's `realm_access.roles` array.
 *
 * This is one of the places where "we now own it" is concrete: there is no role model, no role
 * mapper and no admin console behind this — just a string we write ourselves.
 */
function readRoles(value: unknown): readonly string[] {
  if (typeof value !== "string" || value.length === 0) return [];
  return value
    .split(",")
    .map((role) => role.trim())
    .filter((role) => role.length > 0);
}
