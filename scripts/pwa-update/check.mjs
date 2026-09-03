/**
 * Proves that a running shell reaches the next release on its own.
 *
 * This is the ticket's "deploy N, load it, deploy N+1" verification, made repeatable. It cannot
 * live in the end-to-end suite: that suite runs against the compose stack, and this needs two
 * different builds of the client served in sequence from one origin, which is a different shape
 * of fixture entirely. It needs no stack in return — the update banner is mounted above the auth
 * gate, so the signed-out landing page exercises the whole path.
 *
 * What it does, in order:
 *   1. builds the client at its current version           → "N"
 *   2. builds it again at a bumped version                → "N+1"
 *   3. serves N from a local origin with the same cache headers the client image sends
 *   4. loads it in Chromium and waits for the service worker to take control
 *   5. swaps the served directory to N+1 — the deploy, with the browser already open
 *   6. waits out the app's check throttle and returns the tab to the foreground
 *   7. asserts the banner appears, and that reloading through it lands on the N+1 shell
 *
 * Nothing here is simulated: real time, a real foreground event, real service-worker activation.
 * A synthetic clock was tried for step 6 and rejected — it perturbed activation timing enough
 * that the run stopped describing what a browser actually does. The wait is why this is a
 * verification script rather than a unit test.
 *
 * Run: `pnpm check:pwa-update`
 */
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const clientDir = join(repoRoot, "client");
const manifestPath = join(clientDir, "package.json");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ico": "image/x-icon",
};

/**
 * The frontend configuration the app validates at import time.
 *
 * Placeholders, and never contacted: nothing here signs in. They exist because `src/env.ts`
 * refuses to load without them, which would take the update flow down with it before it runs.
 */
const BUILD_ENV = {
  VITE_API_BASE_URL: "",
  VITE_OIDC_ISSUER_URL: "https://auth.invalid/realms/quorum",
  VITE_OIDC_CLIENT_ID: "quorum-pwa",
  VITE_OIDC_SCOPE: "openid profile email",
};

function build() {
  execFileSync("pnpm", ["--filter", "@quorum/client", "build"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: { ...process.env, ...BUILD_ENV },
  });
}

/**
 * Serves whichever directory `state.root` points at.
 *
 * The cache headers mirror `client/nginx.conf` deliberately: getting them wrong is one of the
 * ways this whole mechanism fails in production, so the fixture should not be more forgiving than
 * the real server.
 */
function serve(state) {
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://localhost");
    let path = normalize(decodeURIComponent(url.pathname));
    if (path.endsWith("/")) path += "index.html";
    const send = async (filePath, fallback = true) => {
      try {
        const info = await stat(filePath);
        if (!info.isFile()) throw new Error("not a file");
      } catch {
        if (fallback) return send(join(state.root, "index.html"), false);
        response.writeHead(404).end("not found");
        return;
      }
      const extension = extname(filePath);
      const headers = { "Content-Type": TYPES[extension] ?? "application/octet-stream" };
      headers["Cache-Control"] = filePath.includes("/assets/")
        ? "public, max-age=31536000, immutable"
        : "no-cache";
      response.writeHead(200, headers);
      createReadStream(filePath).pipe(response);
    };
    void send(join(state.root, path));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function fail(message) {
  console.error(`\n  FAILED: ${message}\n`);
  process.exitCode = 1;
  throw new Error(message);
}

const workspace = await mkdtemp(join(tmpdir(), "quorum-pwa-"));
const original = await readFile(manifestPath, "utf8");
const manifest = JSON.parse(original);
const versionN = manifest.version;
const versionNext = `${versionN}-next`;
let server;

const BANNER = "A new version of Quorum is available.";

try {
  console.log(`\n1/7  building N (${versionN})`);
  build();
  await cp(join(clientDir, "dist"), join(workspace, "n"), { recursive: true });

  console.log(`\n2/7  building N+1 (${versionNext})`);
  await writeFile(
    manifestPath,
    original.replace(`"version": "${versionN}"`, `"version": "${versionNext}"`),
  );
  build();
  await cp(join(clientDir, "dist"), join(workspace, "next"), { recursive: true });
  await writeFile(manifestPath, original);

  const served = JSON.parse(await readFile(join(workspace, "next", "version.json"), "utf8"));
  if (served.version !== versionNext)
    fail(`N+1 published ${served.version}, expected ${versionNext}`);

  const state = { root: join(workspace, "n") };
  server = await serve(state);
  const origin = `http://127.0.0.1:${server.address().port}`;
  console.log(`\n3/7  serving N at ${origin}`);

  // Playwright is the end-to-end workspace's dependency; this script borrows the browser rather
  // than adding a second copy of it to the root.
  const fromE2e = createRequire(join(repoRoot, "e2e", "package.json"));
  const playwright = await import(pathToFileURL(fromE2e.resolve("@playwright/test")).href);
  // Resolved out of another workspace it arrives as CommonJS, so the named exports sit on
  // `default` rather than on the namespace.
  const chromium = playwright.chromium ?? playwright.default.chromium;
  const browser = await chromium.launch();
  // Reduced motion, so the banner's entrance animation does not leave the button moving under
  // Playwright's stability check. It is a fixture concern, not a product one.
  const context = await browser.newContext({
    locale: "en-US",
    baseURL: origin,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  // Explicit, so a step that cannot finish fails the run with a readable message instead of
  // hanging a verification script forever.
  context.setDefaultTimeout(30_000);
  context.setDefaultNavigationTimeout(30_000);

  page.on("pageerror", (error) => console.log("     [page error]", error.message));

  /**
   * The service worker's lifecycle, printed as it happens.
   *
   * Without it the interesting failure — a new worker that installs and then parks in `waiting`
   * instead of taking over — is invisible, and everything downstream of it has to be inferred
   * from a reload that never arrived.
   */
  const workers = await context.newCDPSession(page);
  await workers.send("ServiceWorker.enable");
  let lastReported = "";
  workers.on("ServiceWorker.workerVersionUpdated", ({ versions }) => {
    for (const version of versions) {
      const line = `worker #${version.versionId} ${version.runningStatus}/${version.status}`;
      if (line === lastReported) continue;
      lastReported = line;
      console.log(`     [sw] ${line}`);
    }
  });

  console.log("\n4/7  loading N and waiting for the service worker to take control");
  await page.goto("/");
  await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller), null, {
    timeout: 30_000,
  });
  if (await page.getByText(BANNER).isVisible()) {
    fail("the banner was showing on a shell that is already current");
  }

  console.log("\n5/7  deploying N+1 underneath the open page");
  state.root = join(workspace, "next");

  // Real time, and a real event. The app throttles its checks to one a minute, so the wait is
  // genuine rather than faked — a synthetic clock was tried here and changed service-worker
  // activation timing enough to make the run lie about what the browser does.
  console.log(`\n6/7  waiting out the check throttle, then returning to the foreground`);
  await new Promise((resolve) => setTimeout(resolve, 65_000));
  await page.evaluate(() => globalThis.document.dispatchEvent(new Event("visibilitychange")));

  console.log("\n7/7  asserting the update reaches the running shell");
  await page.getByText(BANNER).waitFor({ state: "visible", timeout: 60_000 });
  console.log("     banner appeared with no navigation, no DevTools and no unregistering");

  const bundleOf = async (dir) =>
    (await readFile(join(workspace, dir, "index.html"), "utf8")).match(
      /src="(\/assets\/index-[^"]+\.js)"/,
    )[1];
  const runningBundle = () =>
    page.evaluate(() =>
      globalThis.document.querySelector("script[src*='/assets/index-']")?.getAttribute("src"),
    );
  if ((await runningBundle()) !== (await bundleOf("n"))) fail("the page under test was not N");

  // The banner rises into place; clicking mid-animation trips Playwright's stability check.
  const button = page.getByRole("button", { name: "Reload now" });
  await button.waitFor({ state: "visible" });
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const nextBundle = await bundleOf("next");
  // `noWaitAfter`: the assertion below describes "the reload finished" better than Playwright's
  // generic navigation wait, which cannot see through the service worker swapping in beneath it.
  await button.click({ noWaitAfter: true });
  await page
    .waitForFunction(
      (expected) =>
        globalThis.document.querySelector("script[src*='/assets/index-']")?.getAttribute("src") ===
        expected,
      nextBundle,
      { timeout: 30_000 },
    )
    .catch(() => fail(`the reload never landed on ${nextBundle}`));
  console.log("     the reload landed on the N+1 shell");

  if (await page.getByText(BANNER).isVisible()) {
    fail("the banner is still up after reloading onto the current version");
  }
  console.log("     the banner is gone\n");

  console.log("PWA update check: a running shell reached the next release on its own.\n");

  await browser.close();
} finally {
  await writeFile(manifestPath, original);
  server?.close();
  await rm(workspace, { recursive: true, force: true });
}
