/**
 * Reading the callback URL, and recovering from a callback this tab cannot complete.
 *
 * THE SITUATION THIS EXISTS FOR. Someone registers, then opens the verification link from their
 * mail client. That opens a **new tab**. Cookies are shared between tabs, so Keycloak recognises
 * the authentication session, finishes the required action, and redirects to this app's callback
 * with a perfectly good `code` and `state`. What is *not* shared between tabs is `sessionStorage`,
 * and that is where the OIDC library keeps the state it is supposed to match against — so the
 * exchange fails in a tab that did nothing wrong.
 *
 * Keycloak appends nothing to that redirect to say "this one came back from e-mail verification":
 * it is `?state&session_state&iss&code`, exactly like any other sign-in return. So the app cannot
 * tell it apart from a stale bookmark by inspecting the URL, and there is no honest notice to show.
 * What it can do is notice that the provider handed it a response, and simply start a fresh sign-in
 * — the browser is holding a Keycloak session by then, so the round trip is silent and the user
 * lands signed in instead of reading an error about storage.
 */

/** What the provider put in the callback URL. */
export type CallbackShape =
  /** `code` and `state`: the provider answered. Whether we can use it is another question. */
  | "response"
  /** `error`: the provider declined — a refused consent, a cancelled login. */
  | "error"
  /** Neither. Nobody was sent here; the URL was opened on its own, e.g. an old bookmark. */
  | "none";

export function callbackShape(search: string): CallbackShape {
  const parameters = new URLSearchParams(search);
  if (parameters.has("error")) return "error";
  if (parameters.has("code") && parameters.has("state")) return "response";
  return "none";
}

/**
 * Marks that this tab has already answered a failed callback with a fresh sign-in.
 *
 * One retry and no more. The recovery ends in another callback, and a bug that made every callback
 * fail would otherwise bounce the browser between the app and the provider forever — the failure
 * mode a user cannot escape, and the one worth spending a storage key to make impossible.
 */
const RETRY_KEY = "quorum.auth.callback-retried";

export function hasRetriedCallback(): boolean {
  try {
    return window.sessionStorage.getItem(RETRY_KEY) !== null;
  } catch {
    // No storage means no retry marker, and no retry either: without somewhere to record the
    // attempt the loop guard does not exist, so the safe answer is "already tried".
    return true;
  }
}

export function markCallbackRetried(): void {
  try {
    window.sessionStorage.setItem(RETRY_KEY, "1");
  } catch {
    // Nothing to do: `hasRetriedCallback` answers true when storage is unavailable, so the retry
    // this would have guarded never happens.
  }
}

export function clearCallbackRetry(): void {
  try {
    window.sessionStorage.removeItem(RETRY_KEY);
  } catch {
    // Ignored for the same reason.
  }
}
