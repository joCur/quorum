import { UserManager, WebStorageStateStore } from "oidc-client-ts";
import { env } from "@/env";

/**
 * OIDC Authorization Code flow with PKCE against the configured issuer.
 *
 * The app is a public client: there is no client secret, PKCE is mandatory, and
 * tokens live in session storage so closing the tab ends the browser session.
 * Refresh happens silently while the tab is open.
 */
export const AUTH_CALLBACK_PATH = "/auth/callback";

export function createUserManager(): UserManager {
  const origin = window.location.origin;
  return new UserManager({
    authority: env.VITE_OIDC_ISSUER_URL,
    client_id: env.VITE_OIDC_CLIENT_ID,
    redirect_uri: `${origin}${AUTH_CALLBACK_PATH}`,
    post_logout_redirect_uri: origin,
    response_type: "code",
    scope: env.VITE_OIDC_SCOPE,
    automaticSilentRenew: true,
    // The authorization code is exchanged from the callback route; keeping the
    // query string out of the address bar afterwards is handled by the router.
    userStore: new WebStorageStateStore({ store: window.sessionStorage }),
    stateStore: new WebStorageStateStore({ store: window.sessionStorage }),
  });
}
