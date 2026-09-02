/**
 * The request context derived from a validated access token.
 *
 * ADR-001 makes tenant and user scope mandatory from day one: every data object carries
 * `tenantId` and `userId`, and every query filters by at least `tenantId`. This type is the only
 * sanctioned source of those two values — they are never read from a request body, a query
 * parameter or a header, because those are attacker-controlled.
 */
export interface RequestContext {
  /** Stable subject identifier from the token (`sub`). Primary key of the acting user. */
  readonly userId: string;
  /** Tenant the acting user belongs to, from the configured tenant claim. */
  readonly tenantId: string;
  /** Realm roles granted to the user, e.g. `quorum-user`, `quorum-admin`. */
  readonly roles: readonly string[];
  /** Preferred username, for logging and display only — never an identity. */
  readonly username: string | undefined;
  /** Email address, if the token carries one. Display only. */
  readonly email: string | undefined;
  readonly issuer: string;
  /** Token expiry as a UNIX timestamp in seconds. */
  readonly expiresAt: number;
}

export function hasRole(context: RequestContext, role: string): boolean {
  return context.roles.includes(role);
}
