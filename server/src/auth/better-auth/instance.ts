import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import { bearer } from "better-auth/plugins/bearer";

/**
 * The better-auth instance for the spike.
 *
 * SPIKE NOTE — this file is the whole "identity provider" that replaces the Keycloak container.
 * It is deliberately small, and that is both the argument for and the argument against the move:
 * everything Keycloak does for us is now something we configure here or do not have at all.
 *
 * Two decisions are encoded below; the reasoning is in `docs/spike-better-auth.md`.
 *
 * 1. **Bearer tokens, not cookies.** The existing contract (`server/src/auth/plugin.ts`) reads a
 *    token from `Authorization` on REST calls and from the `quorum.bearer.v1` subprotocol on the
 *    WebSocket upgrade, because a browser cannot set a header on an upgrade. Cookies would work
 *    for the upgrade but would replace that contract with a same-site/CSRF problem on every
 *    mutating REST route, and the PWA is served from a different origin in development. The
 *    `bearer` plugin makes better-auth accept the session token in `Authorization: Bearer …`, so
 *    the transport stays byte-for-byte what it is today and only the *verification* changes.
 *
 * 2. **Tenant as a field on the user, not the organization plugin.** ADR-001 wants one scalar
 *    `tenantId` on every request, and today a Quorum user belongs to exactly one tenant. The
 *    organization plugin models membership as rows plus an *active organization* on the session,
 *    which is a second, switchable piece of state the entire data layer would have to respect —
 *    real value once a user can belong to several tenants, pure overhead before that. An
 *    `additionalFields` column keeps the request context a plain projection of the user row and
 *    keeps `missing_tenant` a real, testable failure mode.
 */
export interface QuorumAuthOptions {
  /** Signing secret for session tokens and cookies. */
  readonly secret: string;
  /** Public base URL the auth endpoints are mounted under, e.g. `http://localhost:8080`. */
  readonly baseURL: string;
  /** Origins allowed to call the auth endpoints from a browser. */
  readonly trustedOrigins: readonly string[];
  /** Database handle: a `pg` Pool in production, the memory adapter in tests. */
  readonly database: BetterAuthOptions["database"];
  /** Session lifetime in seconds. */
  readonly sessionExpiresInSeconds?: number;
  /** Requests per window an IP may make against the auth endpoints. */
  readonly rateLimitMax?: number;
  /** Length of that window, in seconds. */
  readonly rateLimitWindowSeconds?: number;
  /** Sign-in attempts per window per IP — the brute-force bound. */
  readonly signInRateLimitMax?: number;
}

/** Fixed part of the configuration — shared by the server, the migrator and the tests. */
export function quorumAuthOptions(options: QuorumAuthOptions): BetterAuthOptions {
  return {
    appName: "quorum",
    secret: options.secret,
    baseURL: options.baseURL,
    basePath: "/api/auth",
    trustedOrigins: [...options.trustedOrigins],
    database: options.database,
    emailAndPassword: {
      enabled: true,
      // SPIKE: no mail is sent anywhere in this branch. Turning this on without SMTP would
      // reproduce exactly the dead "Forgot password?" door the production-auth issue describes
      // for Keycloak, so the door is simply not there yet.
      requireEmailVerification: false,
      minPasswordLength: 12,
    },
    user: {
      additionalFields: {
        tenantId: {
          type: "string",
          // `input: false` keeps the field out of the public sign-up endpoint: a user who could
          // choose their own tenant could read another tenant's data, which is the one thing
          // ADR-001 forbids.
          //
          // `required: false` is a compromise, not a preference. better-auth applies `required`
          // to the *input* as well, so "assigned by the server and mandatory" is not expressible:
          // marking it required makes every sign-up fail for a field the caller is forbidden to
          // send. The invariant therefore lives one layer out, in `session-verifier.ts`, which
          // refuses a session whose user has no tenant with the same 403 the token verifier used
          // to return. Keycloak expressed this in the realm as a mapper on a mandatory attribute;
          // here it is our code's job, and a provisioning path that forgets it produces a user
          // who can sign in but cannot use the API.
          required: false,
          input: false,
        },
        roles: {
          type: "string",
          required: false,
          input: false,
        },
      },
    },
    session: {
      expiresIn: options.sessionExpiresInSeconds ?? 60 * 60 * 8,
      // Sliding window: an active tab keeps its session alive, which is what `automaticSilentRenew`
      // does today. The refresh happens server-side on read, so the client has nothing to schedule.
      updateAge: 60 * 60,
    },
    advanced: {
      // The API and the PWA share an origin behind the reverse proxy; the cookie is still issued
      // (better-auth always sets one) but the app authenticates with the bearer token.
      useSecureCookies: options.baseURL.startsWith("https://"),
    },
    /*
     * better-auth's own limiter, made explicit and configurable.
     *
     * It is off by default outside production and silently on inside it, which is exactly the
     * kind of environment-dependent security behaviour that surprises a test suite and then a
     * deployment. Stated here, it is one number in `.env` in both places.
     *
     * This is thinner than what Keycloak provided: it bounds requests per *caller*, where
     * Keycloak's brute-force detection locked the *account* after N failures and could hold a
     * temporary lockout across sources. A distributed attempt at one account is bounded by
     * nothing here beyond the password policy.
     */
    rateLimit: {
      enabled: true,
      window: options.rateLimitWindowSeconds ?? 60,
      max: options.rateLimitMax ?? 120,
      customRules: {
        "/sign-in/email": {
          window: options.rateLimitWindowSeconds ?? 60,
          max: options.signInRateLimitMax ?? 10,
        },
      },
    },
    plugins: [bearer()],
  };
}

export type QuorumAuth = ReturnType<typeof betterAuth>;

export function createQuorumAuth(options: QuorumAuthOptions): QuorumAuth {
  return betterAuth(quorumAuthOptions(options));
}
