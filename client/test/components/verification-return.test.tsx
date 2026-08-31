import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import type { AuthContextValue } from "@/features/auth/auth-provider";
import { callbackShape } from "@/features/auth/callback";
import { renderWithProviders } from "./render";

/**
 * Coming back from the verification mail in a tab that never started a sign-in.
 *
 * Opening the link from a mail client opens a new tab. Cookies are shared, so the provider
 * finishes the required action and sends a real `code` to the callback — but `sessionStorage` is
 * not shared, and that is where the state it has to be matched against lives. The exchange fails
 * in a tab that did nothing wrong, and what the user saw was the OIDC library's own words:
 * "Sign-in did not complete. No matching state found in storage".
 *
 * What has to be true instead: no library message ever reaches a user, and the tab recovers by
 * itself rather than asking the user to press a button that would sign them in without asking for
 * anything — a button that says "sign in" and does not is its own confusion.
 */
const auth = vi.hoisted(() => ({ current: null as AuthContextValue | null }));
const signIn = vi.hoisted(() => vi.fn());
const completeSignIn = vi.hoisted(() => vi.fn());

vi.mock("@/features/auth/auth-provider", () => ({
  useAuth: () => auth.current,
}));

const { AuthCallbackRoute } = await import("@/routes/auth-callback");
const { LandingRoute } = await import("@/routes/landing");

/** The callback URL Keycloak actually produces on the way back from e-mail verification. */
const VERIFICATION_RETURN =
  "/auth/callback?state=abc123&session_state=IjV7GS9u&iss=http%3A%2F%2Flocalhost%3A8091%2Frealms%2Fquorum&code=bc3476dd-a32d";

function setAuth(overrides: Partial<AuthContextValue> = {}): void {
  auth.current = {
    status: "anonymous",
    user: null,
    accessToken: null,
    error: null,
    sessionExpired: false,
    signIn,
    signOut: vi.fn(),
    completeSignIn,
    renewSession: vi.fn(),
    ...overrides,
  };
}

function renderAt(route: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/auth/callback" element={<AuthCallbackRoute />} />
      <Route path="/" element={<LandingRoute />} />
      <Route path="/meetings" element={<p>the meeting list</p>} />
    </Routes>,
    { route },
  );
}

beforeEach(() => {
  window.sessionStorage.clear();
  signIn.mockReset();
  completeSignIn.mockReset();
});

afterEach(() => {
  window.sessionStorage.clear();
});

describe("a callback this tab cannot complete", () => {
  it("starts the flow again by itself, without asking the user for anything", async () => {
    completeSignIn.mockRejectedValue(new Error("No matching state found in storage"));
    setAuth();

    renderAt(VERIFICATION_RETURN);

    await waitFor(() => {
      expect(signIn).toHaveBeenCalledTimes(1);
    });
    // Not a notice with a button: with a provider session in the cookie jar the round trip is
    // silent, and a button labelled "sign in" that signs you in without asking for anything reads
    // like something went wrong when nothing did.
    expect(screen.queryAllByRole("button", { name: "Sign in" })).toHaveLength(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("tries that exactly once, then says so plainly instead of bouncing forever", async () => {
    completeSignIn.mockRejectedValue(new Error("No matching state found in storage"));
    setAuth();

    const first = renderAt(VERIFICATION_RETURN);
    await waitFor(() => {
      expect(signIn).toHaveBeenCalledTimes(1);
    });
    first.unmount();

    // The retry came back just as unusable. This is the loop the marker exists to stop.
    setAuth({ status: "error", error: "sign_in_incomplete" });
    renderAt(VERIFICATION_RETURN);

    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeTruthy();
    });
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toContain("Sign-in did not complete");
    // Never the library's own words, in any language.
    expect(screen.getByRole("alert").textContent).not.toContain("state");
  });

  it("sends a stale bookmark of the callback to the sign-in screen with nothing to apologise for", async () => {
    completeSignIn.mockRejectedValue(new Error("No state in response"));
    setAuth();

    renderAt("/auth/callback");

    await waitFor(() => {
      // The landing page offers sign-in in more than one place; any of them means we are there.
      expect(screen.getAllByRole("button", { name: "Sign in" }).length).toBeGreaterThan(0);
    });
    // Nobody was sent here and nothing failed; an error would be the app inventing a problem.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(signIn).not.toHaveBeenCalled();
  });

  it("says a declined sign-in was declined, in its own words", async () => {
    completeSignIn.mockRejectedValue(new Error("access_denied"));
    setAuth({ status: "error", error: "provider_declined" });

    renderAt("/auth/callback?error=access_denied&state=abc123");

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("cancelled at the sign-in provider");
    });
    expect(signIn).not.toHaveBeenCalled();
  });

  it("goes where it was heading when the exchange works", async () => {
    completeSignIn.mockResolvedValue(null);
    setAuth();

    renderAt(VERIFICATION_RETURN);

    await waitFor(() => {
      expect(screen.getByText("the meeting list")).toBeTruthy();
    });
    expect(signIn).not.toHaveBeenCalled();
  });
});

describe("callbackShape", () => {
  it("reads what the provider put in the URL", () => {
    // Exactly what Keycloak appends on the way back from an action token: code, state,
    // session_state, iss — and nothing at all that says "this one came from verification".
    expect(callbackShape("?state=a&session_state=b&iss=http%3A%2F%2Fx&code=c")).toBe("response");
    expect(callbackShape("?error=access_denied&state=a")).toBe("error");
    expect(callbackShape("")).toBe("none");
    expect(callbackShape("?state=a")).toBe("none");
  });
});
