import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import type { AuthContextValue } from "@/features/auth/auth-provider";
import { renderWithProviders, useLanguage } from "./render";

/**
 * What a signed-out visitor is given.
 *
 * The gate that sends them here is covered by the expired-session tests; what only a rendered test
 * can check is that the gate lands on the landing page rather than on a bare button — the promise,
 * the three steps, the privacy statement — and that every route into the app from this page is the
 * same single sign-in action.
 */
const auth = vi.hoisted(() => ({ current: null as AuthContextValue | null }));
const signInSpy = vi.hoisted(() => vi.fn());

// Replaced wholesale: the real module reaches for the OIDC user manager and its build-time
// configuration, and `useAuth` is the only thing this screen takes from it.
vi.mock("@/features/auth/auth-provider", () => ({
  useAuth: () => auth.current,
}));

const { RequireAuth } = await import("@/features/auth/require-auth");
const { LoginRoute } = await import("@/routes/login");

function setAuth(overrides: Partial<AuthContextValue> = {}): void {
  auth.current = {
    status: "anonymous",
    user: null,
    accessToken: null,
    error: null,
    sessionExpired: false,
    signIn: signInSpy,
    signOut: vi.fn(),
    completeSignIn: vi.fn(),
    renewSession: vi.fn(),
    ...overrides,
  };
}

/** The app's own gate, rendering a protected screen the visitor is not entitled to yet. */
function renderSignedOut(route = "/meetings") {
  return renderWithProviders(
    <Routes>
      <Route
        path="/meetings"
        element={
          <RequireAuth>
            <p>the meeting list</p>
          </RequireAuth>
        }
      />
      <Route path="/login" element={<LoginRoute />} />
    </Routes>,
    { route },
  );
}

describe("the signed-out gate", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  beforeEach(() => {
    setAuth();
    signInSpy.mockReset();
    signInSpy.mockResolvedValue(undefined);
  });

  it("shows the landing page instead of the app", () => {
    renderSignedOut();

    expect(screen.queryByText("the meeting list")).toBeNull();
    expect(
      screen.getByRole("heading", { level: 1, name: /Never take\s*minutes\s*again\./ }),
    ).toBeInTheDocument();
  });

  it("says what using Quorum looks like, in three steps", () => {
    renderSignedOut();

    // A visitor who has never heard of Quorum should be able to tell what happens: they record,
    // they read it back, they hand the minutes on.
    const steps = screen.getAllByRole("listitem");
    expect(steps.map((step) => within(step).getByRole("heading").textContent)).toEqual([
      "Start recording",
      "Read every word",
      "Pass the minutes on",
    ]);
    expect(within(steps[1]!).getByText(/full transcript is ready/)).toBeInTheDocument();
  });

  it("reads the whole promise out at once, however it is animated", () => {
    renderSignedOut();

    // The lead types itself out on screen. A screen reader must get the finished sentence from the
    // first frame rather than following it character by character, so the sentence is the
    // paragraph's accessible name and the animated copy is hidden.
    expect(
      screen.getByLabelText(
        "Quorum records your meeting in the browser. Shortly afterwards the full transcript and a set of minutes in your own outline are waiting for you. You listen instead of writing.",
      ),
    ).toBeInTheDocument();
  });

  it("states plainly who the recordings belong to", () => {
    renderSignedOut();

    const privacy = screen.getByRole("heading", {
      level: 2,
      name: "What is said here is nobody else's business.",
    }).parentElement as HTMLElement;
    expect(
      within(privacy).getByText(/belongs in your account and nowhere else/),
    ).toBeInTheDocument();
    // Deletion is irreversible by design, and the landing is where a visitor should learn that —
    // not the confirmation dialog.
    expect(within(privacy).getByText(/no trash it comes back from/)).toBeInTheDocument();
  });

  it("offers sign-in as the only action, and every one of them signs in", async () => {
    const user = userEvent.setup();
    renderSignedOut();

    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Sign in", "Sign in"]);

    for (const button of buttons) {
      await user.click(button);
    }
    expect(signInSpy).toHaveBeenCalledTimes(2);
  });

  it("carries the visitor's destination through the sign-in", async () => {
    const user = userEvent.setup();
    renderSignedOut("/meetings");

    await user.click(screen.getAllByRole("button", { name: "Sign in" })[0]!);

    expect(signInSpy).toHaveBeenCalledWith("/meetings");
  });

  it("keeps the landing whole when the sign-in has something to say", () => {
    setAuth({ error: "sign_in_incomplete", sessionExpired: true });
    renderSignedOut();

    // The message belongs in the hero, between the promise and the button: a visitor sent back by
    // a failed callback should still see the page they were on, not a bare error screen. What it
    // says is ours and translatable — never the OIDC library's own words.
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Sign-in did not complete. Please try again.",
    );
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    // One message at a time — the failed callback is what just happened.
    expect(screen.queryByText(/Your session ended/)).toBeNull();
  });

  it("closes with a working footer rather than a slogan", () => {
    renderSignedOut();

    // The slogan the artboard put here was struck; what a visitor gets instead is the copyright
    // line and the two legal pages, which have to be reachable without an account.
    expect(screen.getByText(`© Quorum ${new Date().getFullYear()}`)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Legal notice" })).toHaveAttribute(
      "href",
      "/legal/imprint",
    );
    expect(screen.getByRole("link", { name: "Privacy" })).toHaveAttribute("href", "/legal/privacy");
    expect(screen.queryByText(/Your meetings\. Your data\./)).toBeNull();
  });

  it("disables the sign-in while the session is still being restored", () => {
    setAuth({ status: "loading" });
    renderWithProviders(
      <Routes>
        <Route path="/login" element={<LoginRoute />} />
      </Routes>,
      { route: "/login" },
    );

    for (const button of screen.getAllByRole("button", { name: "Sign in" })) {
      expect(button).toBeDisabled();
    }
  });
});
