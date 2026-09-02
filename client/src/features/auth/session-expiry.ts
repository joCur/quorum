/**
 * The one place a 401 from the API is turned into an authentication problem.
 *
 * WHY A SIGNAL AND NOT A HANDLER PER SCREEN: every screen loads its own data, and every one of
 * them would otherwise have to know that one particular failure is not a failure of that data at
 * all. The API clients raise this signal whenever the server answers 401; the auth provider is the
 * single subscriber and owns what happens next — silent renewal first, the login flow if that
 * fails. Adding a screen therefore adds nothing to this path.
 *
 * It is a module-level signal rather than React context because the raisers are plain fetch
 * functions with no component around them.
 */

type Listener = () => void;

const listeners = new Set<Listener>();

export function onUnauthorized(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Reports that the server refused a request for lack of a valid token. */
export function reportUnauthorized(): void {
  for (const listener of [...listeners]) listener();
}

/**
 * Where to return to after signing in again.
 *
 * Only a path within this app is ever kept: an absolute URL or a protocol-relative one would turn
 * the post-login redirect into an open redirect, and the sign-in flow is exactly the moment an
 * attacker would want that.
 */
export function safeReturnTo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  return value;
}

/** The current location, in the form the post-login redirect can navigate back to. */
export function locationTarget(location: {
  pathname: string;
  search?: string;
  hash?: string;
}): string {
  return `${location.pathname}${location.search ?? ""}${location.hash ?? ""}`;
}
