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
 * can check is that the gate lands on the landing page rather than on a bare button — the hero,
 * the three tiles and the privacy promises — and that every route into the app from this page is
 * the same single sign-in action.
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
      screen.getByRole("heading", {
        level: 1,
        name: /You lead the conversation\.\s*Quorum takes the notes\./,
      }),
    ).toBeInTheDocument();
  });

  it("says what the product does before asking anyone to sign in", () => {
    renderSignedOut();

    // The three tiles: capture that is already safe, the transcript, the summary in the user's own
    // template. A visitor who has never heard of Quorum should be able to tell what it does.
    expect(screen.getByText(/every second is already safe/)).toBeInTheDocument();
    expect(screen.getByText("Transcript, word for word")).toBeInTheDocument();
    expect(screen.getByText("A summary in your own sections")).toBeInTheDocument();
    // The template tile shows the user's own section names, which is the whole point of it.
    expect(screen.getAllByRole("listitem").map((item) => item.textContent)).toEqual([
      "— Overview",
      "— Decisions",
      "— Action items",
    ]);
  });

  it("states the privacy promises in plain words", () => {
    renderSignedOut();

    const privacy = screen.getByRole("heading", { level: 2, name: "Your meetings. Your data." })
      .parentElement as HTMLElement;
    expect(within(privacy).getByText("Nothing gets lost")).toBeInTheDocument();
    expect(within(privacy).getByText("Yours alone")).toBeInTheDocument();
    // Deletion is irreversible by design, and the landing is where a visitor should learn that —
    // not the confirmation dialog.
    expect(within(privacy).getByText("Deleted means deleted")).toBeInTheDocument();
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
    setAuth({ error: "invalid_grant", sessionExpired: true });
    renderSignedOut();

    // The message belongs in the hero: a visitor sent back by a failed callback should still see
    // the page they were on, not a bare error screen.
    expect(screen.getByRole("alert")).toHaveTextContent("Sign-in did not complete. invalid_grant");
    expect(screen.getByRole("heading", { level: 1 })).toBeInTheDocument();
    // One message at a time — the failed callback is what just happened.
    expect(screen.queryByText(/Your session ended/)).toBeNull();
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
