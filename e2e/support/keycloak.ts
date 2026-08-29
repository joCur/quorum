import { stackEnv, type DevUser } from "./env.js";

/**
 * Token access outside the browser.
 *
 * The browser flow under test is Authorization Code + PKCE and stays that way. This helper uses
 * the realm's development-only password-grant client instead, for the two things a page cannot
 * do: learning a user's `sub` (which is half of the object-storage prefix an assertion has to
 * look under) and driving the recording endpoint directly to prove cross-tenant denial.
 */

export interface TokenSet {
  accessToken: string;
  /** Subject claim — the `userId` in every tenant/user-scoped object key. */
  userId: string;
  tenantId: string;
}

export async function fetchToken(user: DevUser): Promise<TokenSet> {
  const response = await fetch(
    `${stackEnv.keycloakUrl}/realms/${stackEnv.realm}/protocol/openid-connect/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "password",
        client_id: stackEnv.cliClientId,
        username: user.username,
        password: user.password,
        scope: "openid profile email",
      }),
    },
  );
  if (!response.ok) {
    throw new Error(
      `token request for ${user.username} failed: ${response.status} ${await response.text()}`,
    );
  }
  const body = (await response.json()) as { access_token?: string };
  const accessToken = body.access_token;
  if (!accessToken) throw new Error(`token response for ${user.username} carried no access token`);

  const claims = decodeClaims(accessToken);
  const userId = claims["sub"];
  const tenantId = claims["tenant_id"];
  if (typeof userId !== "string" || typeof tenantId !== "string") {
    throw new Error(`access token for ${user.username} is missing sub or tenant_id`);
  }
  return { accessToken, userId, tenantId };
}

/** Reads the payload of a JWT. Signature validation is the API's job, not the suite's. */
export function decodeClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (payload === undefined) throw new Error("token is not a JWT");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}
