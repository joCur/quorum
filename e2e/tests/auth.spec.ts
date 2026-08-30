import { expect, test } from "../fixtures.js";
import { devUsers, stackEnv } from "../support/env.js";
import { decodeClaims, fetchToken } from "../support/keycloak.js";
import { RecordingSocket, startSession } from "../support/recording-socket.js";

/**
 * Critical path: authentication (CLAUDE.md).
 *
 * Sign-in through the real Keycloak login form, the token the app ends up holding, and the tenant
 * scope that token carries into the API.
 */
test.describe("auth", () => {
  test("signs in through Keycloak and renders the protected view", async ({ page, signIn }) => {
    await page.goto("/meetings");
    // Unauthenticated: the gate sends every protected screen to the sign-in page.
    await expect(page).toHaveURL(/\/login$/);

    await signIn(devUsers.alice);

    // The access token really is in the app's hands, and it is scoped to Alice's tenant.
    const accessToken = await page.evaluate(() => {
      for (let index = 0; index < window.sessionStorage.length; index += 1) {
        const key = window.sessionStorage.key(index);
        if (key === null || !key.startsWith("oidc.user:")) continue;
        const raw = window.sessionStorage.getItem(key);
        if (raw === null) continue;
        return (JSON.parse(raw) as { access_token?: string }).access_token ?? null;
      }
      return null;
    });
    expect(accessToken).not.toBeNull();

    const claims = decodeClaims(accessToken as string);
    expect(claims["preferred_username"]).toBe(devUsers.alice.username);
    expect(claims["tenant_id"]).toBe(devUsers.alice.tenantId);

    // And the API accepts it, reporting the same scope back.
    const me = await page.request.get(`${stackEnv.apiUrl}/api/me`, {
      headers: { authorization: `Bearer ${accessToken as string}` },
    });
    expect(me.ok()).toBe(true);
    expect(await me.json()).toMatchObject({
      tenantId: devUsers.alice.tenantId,
      username: devUsers.alice.username,
    });
  });

  test("rejects a request without a token", async ({ page }) => {
    const response = await page.request.get(`${stackEnv.apiUrl}/api/me`, {
      failOnStatusCode: false,
    });
    expect(response.status()).toBe(401);
  });

  test("keeps tenants apart", async ({ page, signIn }) => {
    // Carol belongs to a second tenant. The meeting list is still the first-run state today, so
    // the UI half of this assertion is deliberately modest: she sees her own empty workspace,
    // never anything of tenant-acme.
    await signIn(devUsers.carol);
    await expect(page.getByRole("heading", { name: "Your first meeting awaits" })).toBeVisible();
    await expect(page.getByText(/acme/i)).toHaveCount(0);

    // The part that matters is enforced server-side, so that is where it is checked: a session
    // owned by Alice's tenant is not addressable with Carol's token. The recording endpoint reads
    // through the caller's tenant/user prefix, so for Carol the session simply does not exist.
    const alice = await fetchToken(devUsers.alice);
    const carol = await fetchToken(devUsers.carol);
    expect(alice.tenantId).not.toBe(carol.tenantId);

    const owned = await startSession(alice.accessToken);
    const intruder = new RecordingSocket(carol.accessToken);
    try {
      await intruder.open();
      intruder.send({
        type: "session.resume",
        sessionId: owned.sessionId,
        at: new Date().toISOString(),
      });
      const closed = await intruder.closeInfo();
      // 1008 — policy violation.
      expect(closed.code).toBe(1008);
      expect(closed.reason).toBe("unknown session");
    } finally {
      intruder.dispose();
      owned.socket.dispose();
    }
  });
});
