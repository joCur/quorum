import { defineConfig, devices } from "@playwright/test";
import { stackEnv } from "./support/env.js";

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
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env["CI"],
  retries: process.env["CI"] ? 1 : 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: process.env["CI"] ? [["github"], ["html", { open: "never" }]] : [["list"]],
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
