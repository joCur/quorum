import {
  expect,
  signInButton,
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

  await page.goto("/");
  await signInButton(page).click();
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

  // Opening the link the way a person does, in another tab, is the whole point of this step. A
  // mail client opens the link in a NEW TAB, which shares the browser's cookies and not its
  // session storage — so the provider recognizes the session, finishes the required action, and
  // sends a real `code` to a tab that has no OIDC state to match it against. Following the link
  // in the tab that registered would sail past that, and did: this spec passed while real users
  // were meeting a raw library error.
  const message = await waitForMessage(account.email);
  expect(message.subject).toMatch(/verify/i);

  const mailTab = await page.context().newPage();
  // Visited first only so the precondition can be asserted on the app's own origin: this tab
  // holds none of the OIDC state the callback will be matched against, while the cookies that
  // make the provider recognise the session are shared with the tab that registered.
  await mailTab.goto("/");
  expect(await mailTab.evaluate(() => window.sessionStorage.length)).toBe(0);

  await mailTab.goto(actionLink(message.body));

  // No button to press and nothing to read: the browser is holding a provider session, so the app
  // starts the flow again on its own and the round trip is silent. The account was created without
  // a tenant, so reaching this screen also means the app asked the API to finish the sign-up and
  // renewed its token — generous timeout for that reason.
  await mailTab.waitForURL(/\/meetings$/, { timeout: 30_000 });
  await expect(mailTab.getByRole("heading", { name: "Your first meeting awaits" })).toBeVisible({
    timeout: 30_000,
  });
  // Whatever else happens, the OIDC library's own words never reach the page.
  await expect(mailTab.getByText(/no matching state/i)).toHaveCount(0);
  await expect(mailTab.getByRole("alert")).toHaveCount(0);

  const protocol = watchRecordingProtocol(mailTab);
  await mailTab.goto("/record");
  await startRecording(mailTab);
  await protocol.waitForSessionId();
  await protocol.waitForAck(2);
  await stopRecording(mailTab);
  await protocol.waitForFinalized();

  await expect(mailTab).toHaveURL(/\/meetings$/);
  // A brand-new account now owns exactly one meeting, which is the shortest true statement that
  // the tenant it was given is the tenant its data is written under.
  await expect(mailTab.getByRole("heading", { name: "Your first meeting awaits" })).toHaveCount(0);
});

test("a stale bookmark of the callback is just the sign-in screen, not an error", async ({
  page,
}) => {
  // The other half of the same rule: an address opened on its own did not fail at anything, so
  // there is nothing to apologise for. It is only here because the fix for the tab above must not
  // turn every stray visit into a redirect loop or a scary screen.
  await page.goto("/auth/callback");

  await expect(signInButton(page)).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

function escapeRegExp(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}
