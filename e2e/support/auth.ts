import { stackEnv, type DevUser } from "./env.js";

/**
 * Session access outside the browser.
 *
 * The browser tests drive the real login form; this helper does the two things a page cannot: it
 * learns a user's id (half of the object-storage prefix every storage assertion looks under) and
 * it drives the recording endpoint directly to prove cross-tenant denial.
 *
 * SPIKE: this replaces `keycloak.ts`. What used to be a development-only password-grant client on
 * the realm is now the same `/api/auth/sign-in/email` endpoint the app itself uses — there is no
 * second, weaker credential path that exists only for tests and must be kept out of production.
 * What is lost is the ability to read the scope out of the credential: a session token is opaque,
 * so the id and tenant come from `/api/me` instead of from decoded claims.
 */

export interface TokenSet {
  accessToken: string;
  /** Acting user's id — the `userId` in every tenant/user-scoped object key. */
  userId: string;
  tenantId: string;
}

export async function fetchToken(user: DevUser): Promise<TokenSet> {
  const response = await fetch(`${stackEnv.apiUrl}/api/auth/sign-in/email`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      // better-auth refuses a state-changing request with no `Origin` (MISSING_OR_NULL_ORIGIN) —
      // its CSRF defence, and a difference from Keycloak's token endpoint, which had none. Any
      // non-browser caller therefore has to present an origin the server trusts.
      origin: stackEnv.clientUrl,
    },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
  if (!response.ok) {
    throw new Error(
      `sign-in for ${user.email} failed: ${response.status} ${await response.text()}`,
    );
  }
  const accessToken = response.headers.get("set-auth-token");
  if (accessToken === null || accessToken.length === 0) {
    throw new Error(`sign-in for ${user.email} returned no session token`);
  }

  return { accessToken, ...(await fetchScope(accessToken)) };
}

/** The scope the API says a token has. The token itself carries nothing readable. */
export async function fetchScope(
  accessToken: string,
): Promise<{ userId: string; tenantId: string }> {
  const me = await fetch(`${stackEnv.apiUrl}/api/me`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!me.ok) throw new Error(`/api/me refused the session token: ${me.status}`);
  const body = (await me.json()) as { userId?: string; tenantId?: string };
  if (typeof body.userId !== "string" || typeof body.tenantId !== "string") {
    throw new Error("/api/me answered without a userId or tenantId");
  }
  return { userId: body.userId, tenantId: body.tenantId };
}
