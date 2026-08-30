import { AuthError } from "./errors.js";
import type { RequestContext } from "./context.js";

/**
 * Verifies a raw credential from the request and produces the tenant-scoped request context.
 *
 * SPIKE NOTE — this used to be "verify a Keycloak-signed JWT". It is now just the shape: the
 * implementation lives in `better-auth/session-verifier.ts` and resolves a better-auth session
 * token instead. Keeping the type here is what made the swap a one-line change in `index.ts`
 * rather than a rewrite of the auth plugin, the recording upgrade and every route.
 */
export type TokenVerifier = (token: string) => Promise<RequestContext>;

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
