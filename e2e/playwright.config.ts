import { defineConfig, devices } from "@playwright/test";
import { stackEnv } from "./support/env.js";

/**
 * Traces, videos and the HTML report go under this run's compose project name.
 *
 * Playwright empties its output directory when it starts, so two concurrent runs sharing one would
 * delete each other's evidence — and only the survivor would have a report. The orchestrator
 * prints the path at startup; a bare `playwright test` keeps the plain folders.
 */
const runArtifacts = process.env["E2E_COMPOSE_PROJECT"]
  ? `/${process.env["E2E_COMPOSE_PROJECT"]}`
  : "";

/**
 * The suite runs against a real stack that the orchestrator (`scripts/run.mjs`) brings up, so
 * there is no `webServer` here: starting compose, the worker and the PWA is more than Playwright's
 * one-command hook can express, and hiding it there would make a single-spec run impossible.
 *
 * Serial by design. The specs share one stack, one bucket and one database, and a recording test
 * that reads object storage while another test writes to it would be flaky for reasons that have
 * nothing to do with the product.
 */
export default defineConfig({
  testDir: "./tests",
  outputDir: `./test-results${runArtifacts}`,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env["CI"],
  // No retries anywhere, and a flaky test fails the run. A suite that guards critical paths is
  // only worth reading if green means "every test passed on its first attempt" — a retry that
  // turns red into green hides exactly the races these tests exist to catch.
  retries: 0,
  failOnFlakyTests: true,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env["CI"]
    ? [["github"], ["html", { open: "never", outputFolder: `./playwright-report${runArtifacts}` }]]
    : [["list"]],
  use: {
    baseURL: stackEnv.clientUrl,
    // en-US is the source locale; pinning it keeps the assertions readable.
    locale: "en-US",
    permissions: ["microphone"],
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        launchOptions: {
          args: [
            // A synthetic microphone: no hardware, no permission prompt, a signal loud enough
            // that the level meter and the silence detection behave like they do for a user.
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream",
            "--autoplay-policy=no-user-gesture-required",
          ],
        },
      },
    },
  ],
});
