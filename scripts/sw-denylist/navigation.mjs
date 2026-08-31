/**
 * Checks the generated service worker's navigation fallback.
 *
 * The PWA precaches its app shell and answers navigations from it. In a deployment the app, the
 * API and the identity provider share one origin behind the edge, so navigations to the sign-in
 * page reach the service worker too — and a fallback that answers them with the app shell makes
 * signing in impossible. Only a same-origin deployment has that shape, so no development setup
 * and no browser test that runs without a worker can notice.
 *
 * This guard reads the worker that a build actually emits, recovers the denylist the workbox
 * navigation route was built with, and applies workbox's own matching rule to a list of URLs. It
 * therefore fails on a missing entry, on a pattern that does not match what it claims to, and on
 * a fallback that lost its denylist entirely.
 */

/** Navigations that must reach the network — the app shell would be the wrong answer. */
export const MUST_BYPASS_FALLBACK = [
  {
    url: "/realms/quorum/protocol/openid-connect/auth?client_id=quorum-pwa&response_type=code",
    what: "the identity provider's sign-in page",
  },
  { url: "/realms/quorum/account/", what: "the identity provider's account console" },
  { url: "/api/meetings", what: "the API" },
  { url: "/ws/recordings/1", what: "the recording WebSocket endpoint" },
  { url: "/healthz", what: "the readiness probe" },
];

/** Navigations the fallback must keep answering, or the app stops working offline. */
export const MUST_USE_FALLBACK = [
  { url: "/", what: "the landing page" },
  { url: "/meetings", what: "the meeting list" },
  { url: "/meetings/018f2c7e-0000-7000-8000-000000000000", what: "a meeting detail route" },
  { url: "/settings?tab=templates", what: "a route with a query string" },
];

/**
 * The denylist the generated worker passes to its navigation route, as real regular expressions.
 *
 * Workbox emits the route as `registerRoute(new NavigationRoute(createHandlerBoundToURL(…),
 * {denylist:[…]}))`, minified onto one line. Returns `null` when the worker registers no
 * navigation fallback at all, which is a different failure and reported as one.
 */
export function extractDenylist(source) {
  const route = /createHandlerBoundToURL\([^)]*\)\s*,\s*\{([^}]*)\}/.exec(source);
  if (route === null) return null;

  const denylist = /denylist\s*:\s*\[([^\]]*)\]/.exec(route[1]);
  if (denylist === null) return [];

  const patterns = [];
  const literal = /\/((?:\\.|\[(?:\\.|[^\]])*\]|[^/\\])+)\/([a-z]*)/g;
  for (const match of denylist[1].matchAll(literal)) {
    patterns.push(new RegExp(match[1], match[2]));
  }
  return patterns;
}

/**
 * Workbox's own decision: a navigation falls back to the app shell unless some denylist entry
 * matches `pathname + search`. Keep this in step with `NavigationRoute` in workbox-routing.
 */
export function fallbackAnswers(denylist, url) {
  const { pathname, search } = new URL(url, "https://quorum.invalid");
  return !denylist.some((pattern) => pattern.test(pathname + search));
}

/**
 * Every way the generated worker's navigation fallback can be wrong, as printable strings. An
 * empty array means the worker is fine.
 */
export function checkNavigationFallback(source) {
  const denylist = extractDenylist(source);
  if (denylist === null) {
    return [
      "the worker registers no navigation fallback — expected a workbox NavigationRoute built " +
        "with createHandlerBoundToURL",
    ];
  }

  const problems = [];
  for (const { url, what } of MUST_BYPASS_FALLBACK) {
    if (fallbackAnswers(denylist, url)) {
      problems.push(
        `a navigation to ${url} (${what}) is answered with the cached app shell — ` +
          `no navigateFallbackDenylist entry matches it`,
      );
    }
  }
  for (const { url, what } of MUST_USE_FALLBACK) {
    if (!fallbackAnswers(denylist, url)) {
      problems.push(
        `a navigation to ${url} (${what}) no longer reaches the app shell — ` +
          `a navigateFallbackDenylist entry is too broad`,
      );
    }
  }
  return problems;
}
