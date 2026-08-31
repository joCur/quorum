import {
  expect,
  startRecording,
  stopRecording,
  test,
  watchRecordingProtocol,
} from "../fixtures.js";
import { stackEnv } from "../support/env.js";
import { actionLink, clearInbox, waitForMessage } from "../support/mailpit.js";

/**
 * Critical path: signing up (CLAUDE.md — the auth flows).
 *
 * The whole way in, through the real Keycloak registration form and the real verification mail:
 * register, open the message in the development relay, follow its link, sign in, and record a
 * meeting. Nothing here reaches past the interface to set an attribute or mark an address
 * verified, because the two steps most likely to break are exactly the ones a shortcut would skip
 * — that the verification mail is actually sent, and that the account arrives with a working
 * tenant on the other side of it.
 *
 * The tenant is the part worth stating plainly. Keycloak creates the account without one, so the
 * first token carries no `tenant_id` and every API route refuses it; the app asks the API to
 * finish the sign-up and renews the token. If that path regressed, this spec would not fail
 * subtly — the meeting list would never render.
 */

/** Unique per run: registration is a write against a realm that keeps its users across specs. */
function freshAccount(): { username: string; email: string; password: string } {
  const suffix = `${String(Date.now())}${String(Math.floor(Math.random() * 1000))}`;
  return {
    username: `new.user.${suffix}`,
    email: `new.user.${suffix}@signup.dev.invalid`,
    password: "correct-horse-battery-staple",
  };
}

test("registers, verifies the address by mail, and lands with a working tenant", async ({
  page,
}) => {
  const account = freshAccount();
  await clearInbox();

  // --- Register through Keycloak's own form -------------------------------------------------
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL(new RegExp(`^${escapeRegExp(stackEnv.keycloakUrl)}/realms/`));

  await page.getByRole("link", { name: /register/i }).click();
  await page.locator("#username").fill(account.username);
  await page.locator("#email").fill(account.email);
  await page.locator("#firstName").fill("New");
  await page.locator("#lastName").fill("User");
  await page.locator("#password").fill(account.password);
  await page.locator("#password-confirm").fill(account.password);
  await page.getByRole("button", { name: /register/i }).click();

  // Registration does not sign anyone in: the address has to be verified first, and the screen
  // says so rather than leaving the user waiting on a page that will not move.
  await expect(page.getByText(/an email with instructions to verify/i)).toBeVisible();

  // --- Verify by following the link in the real message -------------------------------------
  const message = await waitForMessage(account.email);
  expect(message.subject).toMatch(/verify/i);

  await page.goto(actionLink(message.body));

  // --- Sign in, and arrive at a workspace that works ----------------------------------------
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in" }).click();

  const username = page.locator("#username");
  if (await username.isVisible().catch(() => false)) {
    await username.fill(account.username);
    await page.locator("#password").fill(account.password);
    await page.locator("#kc-login").click();
  }

  // The account was created without a tenant, so this only renders once the app has asked the API
  // to finish the sign-up and renewed its token. Generous, because that is two round trips plus a
  // silent renewal on the first sign-in of an account's life.
  await page.waitForURL(/\/meetings$/, { timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Your first meeting awaits" })).toBeVisible({
    timeout: 30_000,
  });

  // --- And the tenant is real: a recording streams and finalizes under it --------------------
  const protocol = watchRecordingProtocol(page);
  await page.goto("/record");
  await startRecording(page);
  await protocol.waitForSessionId();
  await protocol.waitForAck(2);
  await stopRecording(page);
  await protocol.waitForFinalized();

  await expect(page).toHaveURL(/\/meetings$/);
  // A brand-new account now owns exactly one meeting, which is the shortest true statement that
  // the tenant it was given is the tenant its data is written under.
  await expect(page.getByRole("heading", { name: "Your first meeting awaits" })).toHaveCount(0);
});

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
