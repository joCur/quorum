import * as React from "react";
import type { User, UserManager } from "oidc-client-ts";
import { createUserManager } from "@/features/auth/user-manager";

export type AuthStatus = "loading" | "authenticated" | "anonymous" | "error";

interface AuthContextValue {
  status: AuthStatus;
  user: User | null;
  /** Access token for API and WebSocket calls, or null when signed out. */
  accessToken: string | null;
  error: string | null;
  signIn: () => Promise<void>;
  signOut: () => Promise<void>;
  completeSignIn: () => Promise<void>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  // One manager per provider instance, created lazily on first render.
  const [manager] = React.useState<UserManager>(createUserManager);

  const [user, setUser] = React.useState<User | null>(null);
  const [status, setStatus] = React.useState<AuthStatus>("loading");
  const [error, setError] = React.useState<string | null>(null);

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

  const signIn = React.useCallback(async () => {
    setError(null);
    await manager.signinRedirect();
  }, [manager]);

  const signOut = React.useCallback(async () => {
    await manager.signoutRedirect();
  }, [manager]);

  const completeSignIn = React.useCallback(async () => {
    try {
      const next = await manager.signinRedirectCallback();
      adopt(next);
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
      signIn,
      signOut,
      completeSignIn,
    }),
    [status, user, error, signIn, signOut, completeSignIn],
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
