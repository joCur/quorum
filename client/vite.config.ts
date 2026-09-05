import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";

/**
 * Vite configuration for the Quorum PWA (ADR-006).
 *
 * Everything the app needs at runtime is bundled: fonts ship as WOFF2 from
 * `@fontsource`, icons come from `lucide-react`. There are no CDN requests, which
 * is a hard requirement for a self-hosted deployment.
 */
import pkg from "./package.json" with { type: "json" };

/** Origin `vite preview` forwards `/api` and `/ws` to; unset in normal development. */
const apiTarget = process.env["QUORUM_PREVIEW_API_TARGET"];

/**
 * Origin the dev server forwards API, WebSocket and health traffic to.
 *
 * A deployment serves the PWA and the API from one origin, so `VITE_API_BASE_URL` is empty and
 * every request the app makes is same-origin. The dev server listens on its own port, so without
 * a proxy the only way to reach the API would be an absolute base URL — which means CORS on the
 * API and a development setup that no longer matches the shape it ships in. Proxying instead
 * keeps the variable empty in development too.
 */
const devApiTarget = process.env["QUORUM_DEV_API_TARGET"] ?? "http://localhost:8080";

/**
 * Publishes the built version as a tiny static resource the running app can poll.
 *
 * A shell cannot tell from the inside that the deployment has moved past it. Comparing the
 * version compiled into the bundle against this file gives that answer in one request, and it is
 * the only signal that survives a browser with no service worker at all. Deliberately `.json`,
 * which is outside the precache glob — a precached version marker would report the version of the
 * shell asking the question.
 */
function versionManifest(): Plugin {
  return {
    name: "quorum:version-manifest",
    apply: "build",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source: `${JSON.stringify({ version: pkg.version })}\n`,
      });
    },
  };
}

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    versionManifest(),
    VitePWA({
      // `autoUpdate`, not `prompt`. Under `prompt` the OLD shell is the only thing that can ever
      // release a newly installed worker from `waiting` — so a shell with no prompt code, or one
      // whose prompt the user never answers, pins the browser to its version indefinitely. An
      // installed PWA makes that permanent, because the escape hatch of closing every window
      // never happens. `autoUpdate` inverts the dependency: the new worker activates by itself,
      // and the next navigation is answered with the current shell whatever the old one does.
      //
      // The cost is a worker swapped underneath a running page. This app builds as a single
      // bundle with no dynamic imports, so a running page holds all of its code in memory and has
      // nothing left to fetch from a precache that has moved on. What remains — that the running
      // page is still the old version until it reloads — is what the in-app banner says out loud.
      registerType: "autoUpdate",
      // Registration is the app's own (`src/features/pwa`), because applying an update has to
      // defer to a running recording — a decision the plugin's injected script cannot make.
      injectRegister: false,
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Quorum",
        short_name: "Quorum",
        description: "Record your meetings and get transcripts and summaries you can shape.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        // The brand paper surface — the splash and app chrome the installed app
        // opens on. The manifest has no dark counterpart; the `theme-color`
        // metas in index.html carry the light/dark pair for the browser chrome.
        background_color: "#f7f2e9",
        theme_color: "#f7f2e9",
        icons: [
          { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icons/icon-512-maskable.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,woff2}"],
        // A worker that takes over immediately must also clear what the version before it left
        // behind, or every release adds another full copy of the app to the origin's quota.
        cleanupOutdatedCaches: true,
        // The load-bearing line of this whole mechanism, and it has to be set here explicitly:
        // `registerType: "autoUpdate"` does NOT make the worker self-activate. It only makes the
        // plugin's injected script post a `SKIP_WAITING` message — from the OLD page, which is
        // the dependency this app is trying to get rid of, and which is switched off here anyway.
        // Without this, a new worker installs and parks in `waiting` exactly as it did in the
        // incident. With it, activation needs nothing from the page that is being replaced, so
        // even a shell built before any of this code existed gets the new version on its next
        // launch.
        skipWaiting: true,
        // `skipWaiting` activates the new worker but leaves already-open pages under the old one
        // until they next navigate — which is precisely the long-lived tab this ticket is about.
        // Claiming them makes the swap immediate, and hands the app a `controllerchange` to react
        // to rather than a wait for the next version poll.
        clientsClaim: true,
        // Paths the navigation fallback must never answer with the app shell.
        //
        // A deployment puts the app, the API and the identity provider behind one edge on a
        // single origin, so a navigation to the sign-in page is same-origin and the service
        // worker sees it. Without `/realms` here the worker answers that navigation from the
        // precache, the browser never reaches the login form, and signing in is impossible —
        // while every environment that keeps the identity provider on its own origin looks fine.
        //
        // The API and the recording WebSocket are on the list for their own reason too: stale
        // audio or job state would be worse than an honest network error. `/healthz` is a
        // readiness probe, never an app route.
        //
        // Anything listed here must be a path prefix the app itself never routes to. The guard
        // in `scripts/sw-denylist` checks the generated worker against this list.
        navigateFallbackDenylist: [/^\/realms/, /^\/api/, /^\/ws/, /^\/healthz/],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": { target: devApiTarget, changeOrigin: true },
      // The recording WebSocket needs a protocol upgrade. Without `ws: true` the handshake fails
      // while REST keeps working, so the app looks connected but reports itself permanently
      // offline.
      "/ws": { target: devApiTarget, changeOrigin: true, ws: true },
      // Proxied so a readiness check in development reports the API's state, not the dev
      // server's.
      "/healthz": { target: devApiTarget, changeOrigin: true },
    },
  },
  preview: {
    // A deployment serves the PWA and the API from one origin behind a reverse proxy, so the app
    // makes same-origin requests and needs no CORS. `vite preview` is a bare static server, so
    // point it at an API with this variable to reproduce that shape — the end-to-end suite does.
    ...(apiTarget
      ? {
          proxy: {
            "/api": { target: apiTarget, changeOrigin: true },
            "/ws": { target: apiTarget, changeOrigin: true, ws: true },
          },
        }
      : {}),
  },
});
