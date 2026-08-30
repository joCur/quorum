import * as React from "react";
import type { User, UserManager } from "oidc-client-ts";
import { createUserManager } from "@/features/auth/user-manager";
import { onUnauthorized, safeReturnTo } from "@/features/auth/session-expiry";

export type AuthStatus = "loading" | "authenticated" | "anonymous" | "error";

/** Everything a screen can know and do about the current session. */
export interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  /** Access token for API and WebSocket calls, or null when signed out. */
  accessToken: string | null;
  error: string | null;
  /**
   * True once a session ended while the app was open. The sign-in screen says so instead of
   * letting the user wonder why they are looking at it again.
   */
  sessionExpired: boolean;
  /** Starts the OIDC flow, remembering where to come back to afterwards. */
  signIn: (returnTo?: string | null) => Promise<void>;
  signOut: () => Promise<void>;
  /** Finishes the flow and answers with the in-app path to return to, if one was remembered. */
  completeSignIn: () => Promise<string | null>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // One manager per provider instance, created lazily on first render.
  const [manager] = React.useState<UserManager>(createUserManager);

  const [user, setUser] = React.useState<User | null>(null);
  const [status, setStatus] = React.useState<AuthStatus>("loading");
  const [error, setError] = React.useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = React.useState(false);
  // One renewal at a time: a screen that fires several requests answers with several 401s, and
  // each extra silent renewal would be a second round trip for an answer already on its way.
  const renewing = React.useRef<Promise<void> | null>(null);

  const adopt = React.useCallback((next: User | null) => {
    setUser(next);
    setStatus(next && !next.expired ? "authenticated" : "anonymous");
  }, []);

  React.useEffect(() => {
    let active = true;

    void manager
      .getUser()
      .then((existing) => {
        if (active) adopt(existing);
      })
      .catch(() => {
        if (active) setStatus("anonymous");
      });

    const onLoaded = (next: User) => adopt(next);
    const onUnloaded = () => adopt(null);
    manager.events.addUserLoaded(onLoaded);
    manager.events.addUserUnloaded(onUnloaded);
    manager.events.addAccessTokenExpired(onUnloaded);

    return () => {
      active = false;
      manager.events.removeUserLoaded(onLoaded);
      manager.events.removeUserUnloaded(onUnloaded);
      manager.events.removeAccessTokenExpired(onUnloaded);
    };
  }, [manager, adopt]);

  /**
   * The shared answer to a 401: renew silently, and fall back to the login flow.
   *
   * A 401 is an authentication problem, never a data problem, so it is handled once here rather
   * than screen by screen. A silent renewal that works is invisible — the screens re-request with
   * the new token. One that fails drops the user, which makes the auth gate route to the sign-in
   * screen with the current location in hand.
   */
  const recoverSession = React.useCallback(async (): Promise<void> => {
    if (renewing.current) return renewing.current;
    const attempt = (async () => {
      try {
        adopt(await manager.signinSilent());
      } catch {
        // Nothing to renew from, or the provider refused: the session is over.
        await manager.removeUser().catch(() => undefined);
        setSessionExpired(true);
        adopt(null);
      } finally {
        renewing.current = null;
      }
    })();
    renewing.current = attempt;
    return attempt;
  }, [manager, adopt]);

  React.useEffect(() => onUnauthorized(() => void recoverSession()), [recoverSession]);

  const signIn = React.useCallback(
    async (returnTo?: string | null) => {
      setError(null);
      setSessionExpired(false);
      const target = safeReturnTo(returnTo);
      // The target rides along in the OIDC `state`, which the provider hands back untouched at the
      // callback. It is deliberately not a query parameter: the address bar is not a place to keep
      // application state across a redirect the user can bookmark.
      await manager.signinRedirect(target === null ? undefined : { state: { returnTo: target } });
    },
    [manager],
  );

  const signOut = React.useCallback(async () => {
    await manager.signoutRedirect();
  }, [manager]);

  const completeSignIn = React.useCallback(async (): Promise<string | null> => {
    try {
      const next = await manager.signinRedirectCallback();
      adopt(next);
      setSessionExpired(false);
      const state = next.state as { returnTo?: unknown } | undefined;
      return safeReturnTo(state?.returnTo);
    } catch (cause) {
      setStatus("error");
      setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    }
  }, [manager, adopt]);

  const value = React.useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      accessToken: user && !user.expired ? user.access_token : null,
      error,
      sessionExpired,
      signIn,
      signOut,
      completeSignIn,
    }),
    [status, user, error, sessionExpired, signIn, signOut, completeSignIn],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = React.useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used inside an AuthProvider");
  }
  return context;
}
