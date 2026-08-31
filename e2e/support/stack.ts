import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stackEnv } from "./env.js";

/**
 * Control over the running stack, for the tests that need to break something on purpose.
 *
 * Restarting the API container is the honest version of "the server died mid-recording": the open
 * WebSocket goes away, the in-memory session state goes with it, and the client has to reconnect
 * and resume from what object storage says is persisted.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
// Which stack to reach for: the orchestrator exports the project name it generated, and a spec
// run by hand names the stack with E2E_PROJECT. There is no default — every run has its own
// project, so a guess would restart somebody else's API.
const project = process.env["E2E_COMPOSE_PROJECT"] ?? process.env["E2E_PROJECT"];
if (project === undefined || project === "") {
  throw new Error(
    "no compose project to control: run the suite through `pnpm run e2e`, or set E2E_PROJECT to " +
      "the name of the stack that is already up.",
  );
}

const composeArgs = [
  "compose",
  "-p",
  project,
  "--env-file",
  "e2e/e2e.env",
  "-f",
  "docker-compose.yml",
  "-f",
  "e2e/docker-compose.e2e.yml",
];

export async function restartApi(): Promise<void> {
  await docker([...composeArgs, "restart", "-t", "1", "api"]);
  await waitForApi();
}

/** Stops the API without waiting for it to come back — the outage half of a crash. */
export async function stopApi(): Promise<void> {
  await docker([...composeArgs, "stop", "-t", "1", "api"]);
}

export async function startApi(): Promise<void> {
  await docker([...composeArgs, "start", "api"]);
  await waitForApi();
}

async function waitForApi(timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(`${stackEnv.apiUrl}/healthz`, {
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) return;
    } catch {
      // Still restarting.
    }
    if (Date.now() > deadline) throw new Error("the API did not come back after a restart");
    await new Promise((done) => setTimeout(done, 500));
  }
}

function docker(args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn("docker", args, { cwd: repoRoot, stdio: "ignore" });
    child.on("error", fail);
    child.on("exit", (code) =>
      code === 0 ? done() : fail(new Error(`docker ${args.join(" ")} failed (${code})`)),
    );
  });
}
