import type { Page } from "@playwright/test";
import { expect, signInButton, test } from "../fixtures.js";
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
    const accessToken = await readAccessToken(page);
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

  /**
   * The ordinary half of token refresh: the access token has run out, the session has not.
   *
   * This is what happens to every user who leaves a tab open past the token's lifetime, and its
   * whole point is that they never notice. Only the access token is spoiled here — the refresh
   * token is left untouched, which is exactly the state an expired access token leaves behind — so
   * the first API call comes back 401 and the app renews silently instead of asking for anything.
   * The spec below covers the other half, where there is nothing left to renew from; without this
   * one, a regression that turned every expiry into a sign-in prompt would still pass the suite.
   */
  test("renews a stale access token silently and never interrupts the user", async ({
    page,
    signIn,
  }) => {
    await signIn(devUsers.alice);
    await page.goto("/templates");
    await expect(page.getByRole("heading", { name: "Templates" })).toBeVisible();

    const stale = "stale-access-token";
    await page.evaluate((token: string) => {
      for (let index = 0; index < window.sessionStorage.length; index += 1) {
        const key = window.sessionStorage.key(index);
        if (key === null || !key.startsWith("oidc.user:")) continue;
        const raw = window.sessionStorage.getItem(key);
        if (raw === null) continue;
        const stored = JSON.parse(raw) as Record<string, unknown>;
        stored["access_token"] = token;
        window.sessionStorage.setItem(key, JSON.stringify(stored));
      }
    }, stale);

    // Reloading is what makes the app pick the spoiled token up: until then it is still holding the
    // good one in memory, and nothing would come back 401 at all.
    await page.reload();

    // Nothing is asked of the user: the screen renders, and the sign-in page is never reached.
    await expect(page.getByRole("heading", { name: "Templates" })).toBeVisible();
    await expect(page).toHaveURL(/\/templates$/);
    await expect(page.getByText("Your session ended.", { exact: false })).toHaveCount(0);

    // And the token the app now holds is a different, working one — the renewal really happened,
    // rather than the screen rendering from a cache while the session was already gone.
    await expect.poll(async () => readAccessToken(page), { timeout: 20_000 }).not.toBe(stale);

    const renewed = await readAccessToken(page);
    expect(renewed).not.toBeNull();
    const me = await page.request.get(`${stackEnv.apiUrl}/api/me`, {
      headers: { authorization: `Bearer ${renewed as string}` },
    });
    expect(me.ok()).toBe(true);
    expect(await me.json()).toMatchObject({ tenantId: devUsers.alice.tenantId });
  });

  test("routes an expired session into sign-in and returns to where it ended", async ({
    page,
    signIn,
  }) => {
    await signIn(devUsers.alice);
    await page.goto("/templates");
    await expect(page.getByRole("heading", { name: "Templates" })).toBeVisible();

    // The token the app holds is replaced with one the API cannot accept, refresh token included,
    // so the silent renewal has nothing to renew from. This is what a session that outlived its
    // anchor looks like from the app's side: every request comes back 401.
    await page.evaluate(() => {
      for (let index = 0; index < window.sessionStorage.length; index += 1) {
        const key = window.sessionStorage.key(index);
        if (key === null || !key.startsWith("oidc.user:")) continue;
        const raw = window.sessionStorage.getItem(key);
        if (raw === null) continue;
        const stored = JSON.parse(raw) as Record<string, unknown>;
        stored["access_token"] = "not-a-valid-token";
        stored["refresh_token"] = "not-a-valid-refresh-token";
        window.sessionStorage.setItem(key, JSON.stringify(stored));
      }
    });

    await page.reload();

    // Not "your templates could not be loaded": a 401 is an authentication problem, and the app
    // says so and asks the user to sign in again.
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText("Your session ended.", { exact: false })).toBeVisible();
    await expect(page.getByText("could not be loaded")).toHaveCount(0);

    // Signing in again continues where the session ended. Keycloak's own session usually survives,
    // so its login form may not appear at all; when it does, it is filled like anywhere else.
    await signInButton(page).click();
    const username = page.locator("#username");
    if (await username.isVisible().catch(() => false)) {
      await username.fill(devUsers.alice.username);
      await page.locator("#password").fill(devUsers.alice.password);
      await page.locator("#kc-login").click();
    }
    await page.waitForURL(/\/templates$/);
    await expect(page.getByRole("heading", { name: "Templates" })).toBeVisible();
  });

  test("signs out at the provider and lands on the signed-out view", async ({ page, signIn }) => {
    await signIn(devUsers.alice);
    await page.goto("/settings");

    // Signing out drops the local session first, which routes this tab to the signed-out view a
    // moment before the browser leaves for the provider's end-session endpoint. Waiting for that
    // request is what separates the two: everything below then runs on the page the round trip
    // came back to, not on one that is about to be navigated away.
    const endSession = page.waitForRequest((request) =>
      request.url().includes("/protocol/openid-connect/logout"),
    );
    await page.getByRole("button", { name: "Sign out" }).click();
    await endSession;

    // Back at the signed-out landing view, with nothing of the session left in the browser.
    await page.waitForURL(/\/login$/);
    await expect(signInButton(page)).toBeVisible();
    await expect
      .poll(async () =>
        page
          .evaluate(() => {
            let count = 0;
            for (let index = 0; index < window.sessionStorage.length; index += 1) {
              if (window.sessionStorage.key(index)?.startsWith("oidc.user:")) count += 1;
            }
            return count;
          })
          // A read that lands mid-navigation says nothing about the session; asking again is
          // honest, where trusting one arbitrary instant is not.
          .catch(() => -1),
      )
      .toBe(0);

    // And the provider's own session is gone too: signing in again asks for the credentials
    // instead of waving the browser through on a surviving Keycloak cookie.
    await signInButton(page).click();
    await expect(page.locator("#username")).toBeVisible();
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

/**
 * The access token as the app is holding it, read out of the store the OIDC library keeps it in.
 *
 * Several specs need it — to check what it claims, to spoil it, to see it replaced — and each of
 * them wants the token the app would actually send, not one fetched beside it.
 */
async function readAccessToken(page: Page): Promise<string | null> {
  return await page.evaluate(() => {
    for (let index = 0; index < window.sessionStorage.length; index += 1) {
      const key = window.sessionStorage.key(index);
      if (key === null || !key.startsWith("oidc.user:")) continue;
      const raw = window.sessionStorage.getItem(key);
      if (raw === null) continue;
      return (JSON.parse(raw) as { access_token?: string }).access_token ?? null;
    }
    return null;
  });
}
