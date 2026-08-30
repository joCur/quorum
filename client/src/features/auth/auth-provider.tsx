import * as React from "react";
import { authClient, readSessionToken, writeSessionToken } from "@/features/auth/auth-client";
import type { SessionUser } from "@/features/auth/auth-client";
import { onUnauthorized } from "@/features/auth/session-expiry";

export type AuthStatus = "loading" | "authenticated" | "anonymous" | "error";

/**
 * Everything a screen can know and do about the current session.
 *
 * SPIKE: the shape is deliberately close to the OIDC one, so the screens outside this folder
 * (`use-recording`, `use-templates`, `use-meetings`, the app shell's sign-out) compile unchanged.
 * Two members are gone, and their absence is the whole difference in the client's model:
 *
 * * `completeSignIn` — there is no redirect to come back from, so there is no callback route.
 * * `signIn()` no longer *leaves* the app. It takes credentials, because the login form is now
 *   ours. That is the part with a product consequence: we now render, style, translate and
 *   secure the screen where passwords are typed.
 */
export interface AuthContextValue {
  status: AuthStatus;
  user: SessionUser | null;
  /** Session token for API and WebSocket calls, or null when signed out. */
  accessToken: string | null;
  error: string | null;
  /**
   * True once a session ended while the app was open. The sign-in screen says so instead of
   * letting the user wonder why they are looking at it again.
   */
  sessionExpired: boolean;
  /** Signs in with email and password. Rejects with a message the form can show. */
  signIn: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = React.useState<SessionUser | null>(null);
  const [status, setStatus] = React.useState<AuthStatus>("loading");
  const [error, setError] = React.useState<string | null>(null);
  const [sessionExpired, setSessionExpired] = React.useState(false);
  const [token, setToken] = React.useState<string | null>(() => readSessionToken());
  // One renewal at a time: a screen that fires several requests answers with several 401s, and
  // each extra check would be a second round trip for an answer already on its way.
  const renewing = React.useRef<Promise<void> | null>(null);

  const adopt = React.useCallback((next: SessionUser | null) => {
    setUser(next);
    setToken(next === null ? null : readSessionToken());
    setStatus(next === null ? "anonymous" : "authenticated");
  }, []);

  const drop = React.useCallback(() => {
    writeSessionToken(null);
    adopt(null);
  }, [adopt]);

  /** Reads the session the stored token stands for, if there is one. */
  const loadSession = React.useCallback(async (): Promise<SessionUser | null> => {
    if (readSessionToken() === null) return null;
    const { data } = await authClient.getSession();
    return (data?.user as SessionUser | undefined) ?? null;
  }, []);

  React.useEffect(() => {
    let active = true;
    // A token in storage that the server will not resolve is a session that ended while the app
    // was closed — a reload after the session expired, most often. Saying so is the difference
    // between "sign in" and "sign in *again*", and it is the only place the two can be told
    // apart: the credential is opaque, so the client cannot see for itself that it has expired.
    const hadToken = readSessionToken() !== null;
    void loadSession()
      .then((existing) => {
        if (!active) return;
        if (existing === null && hadToken) {
          writeSessionToken(null);
          setSessionExpired(true);
        }
        adopt(existing);
      })
      .catch(() => {
        if (!active) return;
        if (hadToken) setSessionExpired(true);
        setStatus("anonymous");
      });
    return () => {
      active = false;
    };
  }, [loadSession, adopt]);

  /**
   * The shared answer to a 401: re-read the session, and give up if there is none.
   *
   * SPIKE: this replaces `signinSilent()`. There is no refresh token and no hidden iframe — a
   * better-auth session slides forward on every read, so "renewal" is the read itself. That
   * removes a whole class of failure (third-party-cookie policies breaking silent renewal) and
   * removes a capability with it: there is no way to obtain a fresh credential once the old one
   * is gone, so a session that has truly expired always ends at the login form.
   */
  const recoverSession = React.useCallback(async (): Promise<void> => {
    if (renewing.current) return renewing.current;
    const attempt = (async () => {
      try {
        const refreshed = await loadSession();
        if (refreshed === null) throw new Error("no session");
        adopt(refreshed);
      } catch {
        setSessionExpired(true);
        drop();
      } finally {
        renewing.current = null;
      }
    })();
    renewing.current = attempt;
    return attempt;
  }, [loadSession, adopt, drop]);

  React.useEffect(() => onUnauthorized(() => void recoverSession()), [recoverSession]);

  const signIn = React.useCallback(
    async (email: string, password: string) => {
      setError(null);
      setSessionExpired(false);
      const { data, error: failure } = await authClient.signIn.email({ email, password });
      if (failure || !data) {
        const message = failure?.message ?? "sign-in failed";
        setError(message);
        throw new Error(message);
      }
      adopt(data.user as unknown as SessionUser);
    },
    [adopt],
  );

  /**
   * Ends the session on the server and here.
   *
   * SPIKE: no end-session redirect and no provider cookie to worry about — a session is a row,
   * and signing out deletes it. The local cleanup runs either way, because the user asked to be
   * signed out and a server that cannot be reached does not change that.
   */
  const signOut = React.useCallback(async () => {
    try {
      await authClient.signOut();
    } finally {
      drop();
    }
  }, [drop]);

  const value = React.useMemo<AuthContextValue>(
    () => ({
      status,
      user,
      accessToken: status === "authenticated" ? token : null,
      error,
      sessionExpired,
      signIn,
      signOut,
    }),
    [status, user, token, error, sessionExpired, signIn, signOut],
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
