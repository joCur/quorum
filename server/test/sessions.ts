import { memoryAdapter } from "better-auth/adapters/memory";
import { createQuorumAuth } from "../src/auth/better-auth/instance.js";
import type { QuorumAuth } from "../src/auth/better-auth/instance.js";
import { provisionUser } from "../src/auth/better-auth/provisioning.js";
import { createSessionVerifier } from "../src/auth/better-auth/session-verifier.js";
import type { TokenVerifier } from "../src/auth/token-verifier.js";

/**
 * The better-auth replacement for `keys.ts`.
 *
 * SPIKE NOTE — the shape is deliberately the same (`createTestAuth` + `issueSessionToken` mirror
 * `createTestKeyPair` + `signAccessToken`), which is what kept the adaptation of nine test files
 * mechanical. The substance is not the same, and the difference is the honest cost of the move:
 *
 * * The old helper minted tokens offline with a local key pair — no state, no store, and any
 *   claim set the test wanted, including impossible ones (wrong issuer, wrong audience, expired,
 *   missing tenant). Those negative cases were one line each.
 * * This helper needs a *database*, because a session is a row. The memory adapter keeps that
 *   in-process, so the tests are still offline and still fast, but "a token that is invalid in
 *   this particular way" is no longer something a test can simply construct: an opaque session
 *   token is either in the store or it is not.
 *
 * What that removes from the suite is listed in `docs/spike-better-auth.md`.
 */

export const DEFAULT_PASSWORD = "spike-password-12345";

export interface TestAuth {
  readonly auth: QuorumAuth;
  /** Verifier to hand to `buildServer({ auth: { verifyAccessToken } })`. */
  readonly verify: TokenVerifier;
  /** Creates a user (if needed) and returns a bearer session token for them. */
  issueSessionToken(overrides?: SessionOverrides): Promise<string>;
  /** Ends every session of a user, the way an administrator revoking access would. */
  revokeSessions(userId: string): Promise<void>;
}

export interface SessionOverrides {
  /** Forced user id, so a test can keep using the ids its fixtures are written against. */
  readonly subject?: string;
  readonly tenantId?: string | null;
  readonly roles?: string[];
  readonly username?: string;
  readonly email?: string;
}

export async function createTestAuth(): Promise<TestAuth> {
  // One id at a time: `provisionUser` creates exactly one user row per call, so a queued id is
  // unambiguous. Everything else (sessions, accounts) falls back to better-auth's own generator.
  let forcedUserId: string | null = null;

  const auth = createQuorumAuth({
    secret: "spike-test-secret-of-at-least-32-characters",
    baseURL: "http://localhost",
    trustedOrigins: ["http://localhost"],
    // The memory adapter is a plain object of tables; it does not create them on demand, so the
    // four better-auth models are declared up front. This list is the schema better-auth would
    // otherwise have migrated into Postgres.
    database: memoryAdapter({ user: [], session: [], account: [], verification: [] }),
    sessionExpiresInSeconds: 3600,
  });

  // `createQuorumAuth` owns the production configuration; the id override is test-only, so it is
  // applied here rather than being threaded through the production options type.
  (auth.options as { advanced?: Record<string, unknown> }).advanced = {
    ...(auth.options as { advanced?: Record<string, unknown> }).advanced,
    database: {
      generateId: ({ model }: { model: string }) => {
        if (model !== "user" || forcedUserId === null) return crypto.randomUUID();
        const id = forcedUserId;
        forcedUserId = null;
        return id;
      },
    },
  };

  const created = new Map<string, string>();

  return {
    auth,
    verify: createSessionVerifier(auth),

    async issueSessionToken(overrides: SessionOverrides = {}): Promise<string> {
      // Keyed by the *subject* when one is given: the scoping tests mint tokens for several
      // users that differ only in their id, and a shared default email would silently hand them
      // all the same account.
      const label = overrides.username ?? overrides.subject ?? "dev.alice";
      const email = overrides.email ?? `${label}@acme.dev.invalid`;
      const tenantId = overrides.tenantId === null ? "" : (overrides.tenantId ?? "tenant-acme");

      if (!created.has(email)) {
        forcedUserId = overrides.subject ?? crypto.randomUUID();
        const userId = await provisionUser(auth, {
          email,
          password: DEFAULT_PASSWORD,
          name: overrides.username ?? label,
          tenantId,
          ...(overrides.roles ? { roles: overrides.roles } : {}),
        });
        created.set(email, userId);

        if (overrides.tenantId === null) {
          // A user row without a tenant is the `missing_tenant` case. It cannot be produced
          // through sign-up (the field is `input: false` and required), so the test writes it
          // directly — which is itself the point: in this world the case is a data defect rather
          // than a token a client could present.
          const context = await auth.$context;
          await context.adapter.update({
            model: "user",
            where: [{ field: "id", value: userId }],
            update: { tenantId: null },
          });
        }
      }

      const response = await auth.api.signInEmail({
        body: { email, password: DEFAULT_PASSWORD },
        asResponse: true,
      });
      const token = response.headers.get("set-auth-token");
      if (token === null) {
        throw new Error(`sign-in did not return a session token for ${email}`);
      }
      return token;
    },

    async revokeSessions(userId: string): Promise<void> {
      const context = await auth.$context;
      await context.adapter.deleteMany({
        model: "session",
        where: [{ field: "userId", value: userId }],
      });
    },
  };
}
