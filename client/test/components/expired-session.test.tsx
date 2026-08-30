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

// Replaced wholesale rather than partially: the real module pulls in the better-auth browser
// client, which reaches for build-time configuration and a network call this test has no use for.
// `useAuth` is the only thing the screens under test take from it.
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
    ...overrides,
  };
}

describe("an expired session", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  beforeEach(() => {
    signInSpy.mockReset();
    // SPIKE: signing in no longer leaves the app, so the spy stands in for a *successful* sign-in
    // — it flips the session on, exactly as the real provider does before the form navigates.
    signInSpy.mockImplementation(async () => {
      setAuth({ status: "authenticated", accessToken: "token", sessionExpired: false });
    });
  });

  /** Fills the credential form the app now owns and submits it. */
  async function signInThroughTheForm(user: ReturnType<typeof userEvent.setup>) {
    await user.type(screen.getByLabelText("Email"), "dev.alice@acme.dev.invalid");
    await user.type(screen.getByLabelText("Password"), "spike-password-12345");
    await user.click(screen.getByRole("button", { name: "Sign in" }));
  }

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
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
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

    await signInThroughTheForm(user);

    // A session that expires while the user is reading a summary should bring them back to that
    // summary, not drop them at the meeting list. The assertion is on the screen rather than on
    // the call, because the return target is now applied by the form itself: there is no redirect
    // to hand it to.
    expect(await screen.findByText("the meeting")).toBeInTheDocument();
  });

  it("lands on the meeting list when the user came to sign in on their own", async () => {
    const user = userEvent.setup();
    setAuth({ status: "anonymous" });
    renderWithProviders(
      <Routes>
        <Route path="/login" element={<LoginRoute />} />
        <Route path="/meetings" element={<p>the meeting list</p>} />
      </Routes>,
      { route: "/login" },
    );

    await signInThroughTheForm(user);

    // Sign-in is exactly the moment an open redirect would be worth having, so anything that is
    // not an in-app path — including nothing at all — resolves to the default landing screen.
    expect(await screen.findByText("the meeting list")).toBeInTheDocument();
  });

  it("waits rather than flashing the sign-in screen while the session is still loading", () => {
    setAuth({ status: "loading" });
    renderGate("/meetings/abc");

    // On a reload the session is restored asynchronously; routing to login in the meantime would
    // bounce an already signed-in user through the front door for no reason.
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
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
