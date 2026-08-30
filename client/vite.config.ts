import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
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

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react(),
    VitePWA({
      registerType: "prompt",
      injectRegister: "auto",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Quorum",
        short_name: "Quorum",
        description: "Record your meetings and get transcripts and summaries you can shape.",
        start_url: "/",
        scope: "/",
        display: "standalone",
        orientation: "portrait",
        // Matches the `background` token for the light color scheme.
        background_color: "#faf6ee",
        theme_color: "#faf6ee",
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
        // The recording WebSocket and the API are never served from the cache:
        // stale audio or job state would be worse than an honest network error.
        navigateFallbackDenylist: [/^\/api/, /^\/ws/],
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
