import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import type { AuthContextValue } from "@/features/auth/auth-provider";
import { MeetingList } from "@/components/meetings/meeting-list";
import type { MeetingsList } from "@/features/meetings/use-meetings";
import { renderWithProviders, useLanguage } from "./render";

/**
 * What a user meets when their session ends while the app is open.
 *
 * The shared session-expiry signal and the return-target parsing already have logic tests. What
 * only a rendered test can check is the part the user actually sees: that the auth gate hands the
 * whole location to the sign-in screen, that the screen says why it is there, and that a data
 * failure which is not about authentication still says so plainly.
 */
const auth = vi.hoisted(() => ({ current: null as AuthContextValue | null }));
const signInSpy = vi.hoisted(() => vi.fn());

// Replaced wholesale rather than partially: the real module pulls in the OIDC user manager, which
// reaches for build-time configuration and a redirect this test has no use for. `useAuth` is the
// only thing the screens under test take from it.
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

describe("an expired session", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  beforeEach(() => {
    signInSpy.mockReset();
    signInSpy.mockResolvedValue(undefined);
  });

  function renderGate(route: string) {
    return renderWithProviders(
      <Routes>
        <Route
          path="/meetings/:meetingId"
          element={
            <RequireAuth>
              <p>the meeting</p>
            </RequireAuth>
          }
        />
        <Route path="/login" element={<LoginRoute />} />
      </Routes>,
      { route },
    );
  }

  it("sends the user to sign in rather than leaving the screen on a load error", () => {
    setAuth({ status: "anonymous", sessionExpired: true });
    renderGate("/meetings/abc");

    expect(screen.queryByText("the meeting")).toBeNull();
    // The landing offers sign-in twice — in the header and under the hero — so a visitor who has
    // scrolled never has to scroll back to act.
    expect(screen.getAllByRole("button", { name: "Sign in" })).not.toHaveLength(0);
  });

  it("says the session ended, so the sign-in screen is not a mystery", () => {
    setAuth({ status: "anonymous", sessionExpired: true });
    renderGate("/meetings/abc");

    // Without this, a user who was mid-task is looking at the front door again with no
    // explanation — the same confusion the old load-error message caused, one screen along.
    expect(
      screen.getByText("Your session ended. Sign in again to continue where you left off."),
    ).toBeInTheDocument();
  });

  it("stays quiet about expiry on an ordinary first sign-in", () => {
    setAuth({ status: "anonymous", sessionExpired: false });
    renderGate("/meetings/abc");

    // Nothing ended; saying so would be a small lie on the very first screen a user sees.
    expect(screen.queryByText(/Your session ended/)).toBeNull();
  });

  it("carries the whole location back through sign-in, query and fragment included", async () => {
    const user = userEvent.setup();
    setAuth({ status: "anonymous", sessionExpired: true });
    renderGate("/meetings/abc?tab=summary#section-2");

    await user.click(screen.getAllByRole("button", { name: "Sign in" })[0]!);

    // A session that expires while the user is reading a summary should bring them back to that
    // summary, not drop them at the meeting list.
    expect(signInSpy).toHaveBeenCalledWith("/meetings/abc?tab=summary#section-2");
  });

  it("has nothing to return to when the user came to sign in on their own", async () => {
    const user = userEvent.setup();
    setAuth({ status: "anonymous" });
    renderWithProviders(
      <Routes>
        <Route path="/login" element={<LoginRoute />} />
      </Routes>,
      { route: "/login" },
    );

    await user.click(screen.getAllByRole("button", { name: "Sign in" })[0]!);

    // Sign-in is exactly the moment an open redirect would be worth having, so anything that is
    // not an in-app path — including nothing at all — resolves to no target.
    expect(signInSpy).toHaveBeenCalledWith(null);
  });

  it("waits rather than flashing the sign-in screen while the session is still loading", () => {
    setAuth({ status: "loading" });
    renderGate("/meetings/abc");

    // On a reload the session is restored asynchronously; routing to login in the meantime would
    // bounce an already signed-in user through the front door for no reason.
    expect(screen.queryAllByRole("button", { name: "Sign in" })).toHaveLength(0);
    expect(screen.queryByText("the meeting")).toBeNull();
  });

  it("shows the screen once the session is good", () => {
    setAuth({ status: "authenticated", accessToken: "token" });
    renderGate("/meetings/abc");

    expect(screen.getByText("the meeting")).toBeInTheDocument();
  });
});

/**
 * The other half of the same decision: a 401 is handled centrally and the screens keep quiet about
 * it, but a genuine data failure still has to say so.
 */
describe("a data failure that is not about authentication", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  it("still names the problem and offers a retry", () => {
    const list: MeetingsList = {
      meetings: [],
      status: "error",
      errorCode: "network",
      deleting: new Set<string>(),
      reload: vi.fn(),
      remove: vi.fn(),
    };

    renderWithProviders(
      <MeetingList
        list={list}
        searching={false}
        onClearSearch={vi.fn()}
        onboarding={<p>onboarding</p>}
      />,
    );

    expect(screen.getByText("Your meetings could not be loaded.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
    // The worst possible reading of a failed load: telling the user they have no meetings.
    expect(screen.queryByText("onboarding")).toBeNull();
  });
});
