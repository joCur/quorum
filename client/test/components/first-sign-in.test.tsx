import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { AuthContextValue } from "@/features/auth/auth-provider";
import { renderWithProviders } from "./render";

/**
 * The first sign-in of a self-registered account.
 *
 * The account exists at the identity provider before it has a workspace here, so its first token
 * carries no tenant and every screen behind the gate would answer 403. What a rendered test can
 * check, and a logic test cannot, is that the user is told the workspace is being set up rather
 * than being shown a broken screen, and that the app renews the token afterwards — without which
 * it would go straight on to make requests with the same tenant-less token it started with.
 */
const auth = vi.hoisted(() => ({ current: null as AuthContextValue | null }));

vi.mock("@/features/auth/auth-provider", () => ({
  useAuth: () => auth.current,
}));

const { RequireTenant } = await import("@/features/auth/require-tenant");

/** A signed token shape — only the payload is ever read, and only for the tenant claim. */
function token(claims: Record<string, unknown>): string {
  const payload = btoa(JSON.stringify(claims)).replaceAll("+", "-").replaceAll("/", "_");
  return `header.${payload}.signature`;
}

// One stable spy across a test, because a renewal replaces the token rather than the session.
const renewSession = vi.fn(async () => {
  // A renewal is what puts the new tenant into the token: the provider mints it, so the test does
  // the same thing here.
  setToken(token({ sub: "user-1", tenant_id: "tenant-user-1" }));
});

function setToken(accessToken: string | null): void {
  auth.current = {
    status: "authenticated",
    user: null,
    accessToken,
    error: null,
    sessionExpired: false,
    signIn: vi.fn(),
    signOut: vi.fn(),
    completeSignIn: vi.fn(),
    renewSession,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  renewSession.mockClear();
});

describe("the first sign-in of a self-registered account", () => {
  it("renders straight through for a token that already carries a tenant", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    setToken(token({ sub: "user-1", tenant_id: "tenant-acme" }));

    renderWithProviders(
      <RequireTenant>
        <p>the app</p>
      </RequireTenant>,
    );

    expect(screen.getByText("the app")).toBeTruthy();
    // The common case costs nothing: no request on every load to learn what the token says.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("waves a token it cannot read through, instead of treating it as a new account", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    // What an expired session looks like once the app has replaced its token with a rejected one.
    setToken("not-a-valid-token");

    renderWithProviders(
      <RequireTenant>
        <p>the app</p>
      </RequireTenant>,
    );

    // The screen behind this renders, its first request comes back 401, and the sign-in machinery
    // takes it from there. Parking it on a setup screen would strand the session for good.
    expect(screen.getByText("the app")).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("sets the workspace up, renews the token and then shows the app", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ tenantId: "tenant-user-1", tokenStale: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    setToken(token({ sub: "user-1" }));

    const { rerender } = renderWithProviders(
      <RequireTenant>
        <p>the app</p>
      </RequireTenant>,
    );

    expect(screen.getByRole("status").textContent).toContain("Setting up your workspace");

    await waitFor(() => {
      expect(renewSession).toHaveBeenCalled();
    });

    rerender(
      <RequireTenant>
        <p>the app</p>
      </RequireTenant>,
    );
    await waitFor(() => {
      expect(screen.getByText("the app")).toBeTruthy();
    });
  });

  it("says so and offers another go when the setup call fails", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(null, { status: 503 }));
    setToken(token({ sub: "user-1" }));

    renderWithProviders(
      <RequireTenant>
        <p>the app</p>
      </RequireTenant>,
    );

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain("could not be set up");
    });
    // Not "sign in again": nothing is wrong with the session, so the app does not throw it away.
    expect(screen.queryByText("the app")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
    });
  });
});
