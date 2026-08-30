import { createAuthClient } from "better-auth/react";
import { apiUrl } from "@/env";

/**
 * better-auth's browser client, configured for bearer tokens rather than cookies.
 *
 * WHY BEARER AND NOT THE COOKIE better-auth SETS BY DEFAULT:
 *
 * 1. The recording WebSocket. A browser cannot set a header on an upgrade, so the token travels
 *    in the `quorum.bearer.v1` subprotocol (`shared/src/websocket-auth.ts`). The app therefore
 *    has to be able to *read* its own credential — something an httpOnly cookie exists precisely
 *    to prevent. A cookie would ride along on the upgrade automatically, but only same-site, and
 *    it would then be the one authentication path with different rules from every other call.
 * 2. Development serves the PWA and the API from different origins.
 *
 * The honest cost: a readable token is XSS-reachable, where an httpOnly cookie is not. Today the
 * OIDC access token sits in `sessionStorage` for exactly the same reason, so this is not a
 * regression — but it is not the improvement a cookie-only design would have been either.
 */
const TOKEN_KEY = "quorum.session-token";

/** The token the app currently holds, or null. Session storage: closing the tab ends it. */
export function readSessionToken(): string | null {
  try {
    return window.sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function writeSessionToken(token: string | null): void {
  try {
    if (token === null) window.sessionStorage.removeItem(TOKEN_KEY);
    else window.sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    // A browser with storage disabled still gets a working session for this page load.
  }
}

export const authClient = createAuthClient({
  baseURL: apiUrl("/api/auth"),
  fetchOptions: {
    auth: {
      type: "Bearer",
      token: () => readSessionToken() ?? "",
    },
    onSuccess: (context: { response: Response }) => {
      // Every successful auth call may hand back a fresh session token; the sliding session in
      // `server/src/auth/better-auth/instance.ts` is what makes that the renewal mechanism.
      const token = context.response.headers.get("set-auth-token");
      if (token !== null && token.length > 0) writeSessionToken(token);
    },
  },
});

export type SessionUser = {
  id: string;
  email: string;
  name: string;
};
