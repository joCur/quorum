import { expect, test } from "../fixtures.js";
import { devUsers, stackEnv } from "../support/env.js";
import { fetchScope, fetchToken } from "../support/auth.js";
import { RecordingSocket, startSession } from "../support/recording-socket.js";

/**
 * Critical path: authentication (CLAUDE.md).
 *
 * SPIKE: sign-in through the app's own login form, the session token the app ends up holding, and
 * the tenant scope the API derives from it. The shape of the path is unchanged; what changed is
 * that no part of it leaves the application, and that the scope is read from the API rather than
 * decoded out of the credential.
 */
test.describe("auth", () => {
  test("signs in through the app's own form and renders the protected view", async ({
    page,
    signIn,
  }) => {
    await page.goto("/meetings");
    // Unauthenticated: the gate sends every protected screen to the sign-in page.
    await expect(page).toHaveURL(/\/login$/);

    await signIn(devUsers.alice);

    // The session token really is in the app's hands, and the API scopes it to Alice's tenant.
    const accessToken = await page.evaluate(() =>
      window.sessionStorage.getItem("quorum.session-token"),
    );
    expect(accessToken).not.toBeNull();

    // The token itself says nothing — it is opaque. Only the API can resolve it, which is the
    // substantive difference from a JWT and the reason this assertion moved server-side.
    expect(accessToken).not.toContain("{");
    expect(await fetchScope(accessToken as string)).toMatchObject({
      tenantId: devUsers.alice.tenantId,
    });

    // And the API accepts it, reporting the same scope back.
    const me = await page.request.get(`${stackEnv.apiUrl}/api/me`, {
      headers: { authorization: `Bearer ${accessToken as string}` },
    });
    expect(me.ok()).toBe(true);
    expect(await me.json()).toMatchObject({
      tenantId: devUsers.alice.tenantId,
      username: devUsers.alice.name,
    });
  });

  test("rejects a request without a token", async ({ page }) => {
    const response = await page.request.get(`${stackEnv.apiUrl}/api/me`, {
      failOnStatusCode: false,
    });
    expect(response.status()).toBe(401);
  });

  test("routes an expired session into sign-in and returns to where it ended", async ({
    page,
    signIn,
  }) => {
    await signIn(devUsers.alice);
    await page.goto("/templates");
    await expect(page.getByRole("heading", { name: "Templates" })).toBeVisible();

    // The token the app holds is replaced with one the API cannot accept. There is no refresh
    // token to invalidate as well — a session either resolves or it does not — so this single
    // write is the whole "session that outlived its anchor" scenario.
    await page.evaluate(() => {
      window.sessionStorage.setItem("quorum.session-token", "not-a-valid-session-token");
    });

    await page.reload();

    // Not "your templates could not be loaded": a 401 is an authentication problem, and the app
    // says so and asks the user to sign in again.
    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByText("Your session ended.", { exact: false })).toBeVisible();
    await expect(page.getByText("could not be loaded")).toHaveCount(0);

    // Signing in again continues where the session ended. There is no provider session that might
    // wave the user straight through, so the credentials are always asked for — one behaviour
    // instead of two, which is also one fewer branch in this test.
    await page.getByLabel("Email").fill(devUsers.alice.email);
    await page.getByLabel("Password").fill(devUsers.alice.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForURL(/\/templates$/);
    await expect(page.getByRole("heading", { name: "Templates" })).toBeVisible();
  });

  test("signs out and lands on the signed-out view", async ({ page, signIn }) => {
    await signIn(devUsers.alice);
    await page.goto("/settings");

    // SPIKE: there is no end-session redirect to wait for. Signing out is one API call that
    // deletes the session row, so the assertion is simply that nothing of it survives — in the
    // browser or on the server.
    const token = await page.evaluate(() => window.sessionStorage.getItem("quorum.session-token"));
    expect(token).not.toBeNull();

    await page.getByRole("button", { name: "Sign out" }).click();
    await page.waitForURL(/\/login$/);
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();

    await expect
      .poll(async () =>
        page
          .evaluate(() => window.sessionStorage.getItem("quorum.session-token"))
          // A read that lands mid-navigation says nothing about the session; asking again is
          // honest, where trusting one arbitrary instant is not.
          .catch(() => "still-navigating"),
      )
      .toBeNull();

    // And the server has forgotten it too: the revoked token is refused, where a Keycloak access
    // token would have stayed valid until it expired.
    const refused = await page.request.get(`${stackEnv.apiUrl}/api/me`, {
      headers: { authorization: `Bearer ${token as string}` },
      failOnStatusCode: false,
    });
    expect(refused.status()).toBe(401);
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
