#!/usr/bin/env node
/**
 * CLI for the service worker navigation guard. See `navigation.mjs` for what it checks.
 *
 * It reads the worker a client build emitted, so it runs after `pnpm run build` — with no build
 * output there is nothing to check and the guard says so rather than passing quietly.
 *
 * Exit codes: 0 when the fallback is safe, 1 when it is not, 2 when the guard cannot run.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkNavigationFallback } from "./navigation.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const worker = path.join(repoRoot, "client", "dist", "sw.js");

if (!existsSync(worker)) {
  console.error(
    `service worker guard: ${path.relative(repoRoot, worker)} is missing — build the client first ` +
      `(\`pnpm run build\`).`,
  );
  process.exit(2);
}

const problems = checkNavigationFallback(readFileSync(worker, "utf8"));
if (problems.length > 0) {
  console.error("service worker guard: the navigation fallback would break these navigations:");
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("\nFix the `navigateFallbackDenylist` in client/vite.config.ts and build again.");
  process.exit(1);
}

console.log("service worker guard: the navigation fallback leaves non-app paths to the network.");
