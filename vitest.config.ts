import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vitest/config";

// The client reads its version from a Vite-injected constant; tests import the same modules,
// so the constant has to exist here too.
const define = { __APP_VERSION__: JSON.stringify("0.0.0-test") };

const resolve = {
  alias: {
    // Mirrors the web client's own alias so its modules resolve in tests too.
    "@": fileURLToPath(new URL("./client/src", import.meta.url)),
  },
};

/**
 * The client validates its build-time configuration on import and throws when it is missing
 * (`client/src/env.ts`), which is the behavior a misconfigured deployment should get. Tests that
 * import client modules therefore need values here. `VITE_API_BASE_URL` is set on purpose: with
 * an explicit base, building an API URL never touches `window`, so the logic suite stays plain
 * Node tests.
 */
const env = {
  VITE_API_BASE_URL: "https://api.test.invalid",
  VITE_OIDC_ISSUER_URL: "https://auth.test.invalid/realms/quorum",
  VITE_OIDC_CLIENT_ID: "quorum-pwa",
};

/**
 * Two suites, because they need two different worlds.
 *
 * `logic` is everything that can be reasoned about without a document: schemas, protocol framing,
 * formatting, timing gates. It runs in Node, which keeps it fast and keeps the temptation to
 * reach for a DOM out of it.
 *
 * `components` renders real components into jsdom. It is the layer that catches a status badge
 * showing the wrong state, a confirmation that does not actually block, or a missing translation
 * key — none of which a logic test can see, and none of which is worth a full end-to-end run.
 * Behavior only: these tests assert what a user can perceive, never a rendered-output snapshot,
 * which would fail on every deliberate change and pass on most of the real regressions.
 */
export default defineConfig({
  test: {
    projects: [
      {
        define,
        resolve,
        test: {
          name: "logic",
          globals: true,
          environment: "node",
          // Repo toolchain scripts under `scripts/` are plain ESM with no build step, so their
          // tests sit next to them instead of in a `test/` directory. The end-to-end harness has
          // scripts of the same kind; only its Playwright specs have to stay out of this suite,
          // which is why the exclusion names `e2e/tests` rather than all of `e2e`.
          include: ["**/test/**/*.test.ts", "scripts/**/*.test.mjs", "e2e/scripts/**/*.test.mjs"],
          exclude: ["**/node_modules/**", "**/dist/**", "e2e/tests/**"],
          env,
        },
      },
      {
        define,
        resolve,
        test: {
          name: "components",
          globals: true,
          environment: "jsdom",
          include: ["client/test/components/**/*.test.tsx"],
          setupFiles: ["./client/test/components/setup.ts"],
          env,
        },
      },
    ],
  },
});
