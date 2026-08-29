import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // The client reads its version from a Vite-injected constant; tests import the same modules,
  // so the constant has to exist here too.
  define: { __APP_VERSION__: JSON.stringify("0.0.0-test") },
  resolve: {
    alias: {
      // Mirrors the web client's own alias so its modules resolve in tests too.
      "@": fileURLToPath(new URL("./client/src", import.meta.url)),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["**/test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "e2e/**"],
    /**
     * The client validates its build-time configuration on import and throws when it is missing
     * (`client/src/env.ts`), which is the behavior a misconfigured deployment should get. Tests
     * that import client modules therefore need values here. `VITE_API_BASE_URL` is set on
     * purpose: with an explicit base, building an API URL never touches `window`, so these stay
     * plain Node tests.
     */
    env: {
      VITE_API_BASE_URL: "https://api.test.invalid",
      VITE_OIDC_ISSUER_URL: "https://auth.test.invalid/realms/quorum",
      VITE_OIDC_CLIENT_ID: "quorum-pwa",
    },
  },
});
