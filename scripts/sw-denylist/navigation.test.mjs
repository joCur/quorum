import { describe, expect, it } from "vitest";

import { checkNavigationFallback, extractDenylist, fallbackAnswers } from "./navigation.mjs";

/** The shape workbox emits, minified onto one line, with the denylist under test spliced in. */
function generatedWorker(denylist) {
  return (
    `self.addEventListener("message",e=>{});` +
    `registerRoute(new NavigationRoute(createHandlerBoundToURL("index.html"),` +
    `{denylist:[${denylist}]}))`
  );
}

describe("service worker navigation guard", () => {
  it("recovers the denylist from the generated worker", () => {
    const denylist = extractDenylist(generatedWorker(String.raw`/^\/realms/,/^\/api/i`));

    expect(denylist.map((pattern) => pattern.source)).toEqual([
      String.raw`^\/realms`,
      String.raw`^\/api`,
    ]);
    expect(denylist[1].flags).toBe("i");
  });

  it("reports a worker without a navigation fallback", () => {
    expect(checkNavigationFallback("registerRoute(new Route(() => false))")).toEqual([
      expect.stringContaining("no navigation fallback"),
    ]);
  });

  it("matches on path and query, the way workbox does", () => {
    const denylist = [/^\/realms/];

    expect(fallbackAnswers(denylist, "/realms/quorum/protocol/openid-connect/auth?a=b")).toBe(
      false,
    );
    expect(fallbackAnswers(denylist, "/meetings?realms=1")).toBe(true);
  });

  it("accepts the denylist the client is configured with", () => {
    const worker = generatedWorker(String.raw`/^\/realms/,/^\/api/,/^\/ws/,/^\/healthz/`);

    expect(checkNavigationFallback(worker)).toEqual([]);
  });

  it("rejects a denylist that lets the identity provider be answered from the cache", () => {
    const worker = generatedWorker(String.raw`/^\/api/,/^\/ws/`);

    expect(checkNavigationFallback(worker)).toEqual([
      expect.stringContaining("/realms/quorum/protocol/openid-connect/auth"),
      expect.stringContaining("/realms/quorum/account/"),
      expect.stringContaining("/healthz"),
    ]);
  });

  it("rejects a denylist so broad that app routes stop reaching the shell", () => {
    const worker = generatedWorker(String.raw`/^\/realms/,/^\/api/,/^\/ws/,/^\/healthz/,/^\//`);

    expect(checkNavigationFallback(worker)).toEqual([
      expect.stringContaining("/"),
      expect.stringContaining("/meetings"),
      expect.stringContaining("/meetings/018f2c7e-0000-7000-8000-000000000000"),
      expect.stringContaining("/settings?tab=templates"),
    ]);
  });
});
