// Single entry point for the end-to-end suite: `pnpm run e2e` from the repository root.
//
// It owns the whole run — stack up, application processes, tests, teardown — because the suite
// spans four processes and a browser, and a developer should not have to assemble that by hand.
//
// What runs where:
//   * compose (its own per-run project): Postgres, Keycloak, MinIO, the API, and Whisper on request
//   * host: the transcription worker, the built PWA, and Playwright
//
// The worker and the PWA run on the host on purpose. The worker has no image yet, and building
// the PWA here is what lets the suite point it at this stack's API and issuer without a second
// set of committed configuration files.
//
// Isolation: every run gets its own compose project name and its own set of host ports, so two
// runs on one machine — and a development or demo stack next to them — never meet. See
// `resolveProjectName` and `resolvePorts` for how the two interact with the reuse loop.
//
// Evidence: teardown deletes the stack, so a stack that never came up would take the only account
// of why with it. A failure during startup therefore copies the containers' logs into the
// Playwright artifact directory first — see `captureStackLogs`.
//
// Environment:
//   E2E_WHISPER=mock|real   mock (default) uses the stub transcription endpoint; real starts the
//                           CPU Whisper container with the smallest model
//   E2E_KEEP_STACK=1        leave the stack running after the tests, for debugging
//   E2E_REUSE_STACK=1       assume the stack is already up and skip `compose up`
//   E2E_PROJECT=<name>      name this run's compose project explicitly, instead of the generated
//                           per-run name (see `resolveProjectName`)
//   <PORT VARIABLE>=<port>  pin one host port instead of taking a free one; the run still refuses
//                           to start when something already holds it
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const e2eDir = resolve(here, "..");
const repoRoot = resolve(e2eDir, "..");

/**
 * True when this run wrote `.stack.env` itself. Volumes left over from an earlier run carry the
 * previous credentials, so the combination is unusable and must be refused rather than debugged.
 */
let credentialsAreNew = false;

/**
 * Every host port this run owns. Compose reads the first eight through the process environment
 * (which beats `--env-file`); the last two belong to processes this script starts on the host.
 *
 * The list has to be complete: a service whose port is not here keeps the template's fixed
 * default, and that default is exactly what a demo stack on the same machine already holds.
 */
const portVariables = [
  "API_PORT",
  "KEYCLOAK_PORT",
  "POSTGRES_PORT",
  "MINIO_PORT",
  "MINIO_CONSOLE_PORT",
  "MAILPIT_UI_PORT",
  "WHISPER_PORT",
  // The PWA, served by `vite preview` on the host. Keycloak learns about this origin at startup
  // (see `allowClientOrigin`), which is what frees it from the realm's fixed redirect URIs.
  "CLIENT_PORT",
  "MOCK_WHISPER_PORT",
  "WORKER_METRICS_PORT",
];

const whisperMode = process.env.E2E_WHISPER === "real" ? "real" : "mock";
const keepStack = process.env.E2E_KEEP_STACK === "1";
const reuseStack = process.env.E2E_REUSE_STACK === "1";

const projectName = resolveProjectName();
const ports = await resolvePorts();

const credentials = loadCredentials();
const stack = { ...parseEnvFile(localEnvFile()), ...credentials, ...ports };
// Compose reads these from the process environment, which takes precedence over `--env-file` —
// that is how the generated credentials and this run's ports reach the containers.
Object.assign(process.env, credentials, ports);

const mockWhisperPort = Number(ports.MOCK_WHISPER_PORT);
// Mirrors the worker's own variable (`WORKER_METRICS_PORT` in worker/src/config.ts): the worker
// binds this port, so the run must own it even though nothing here polls it.
const workerMetricsPort = Number(ports.WORKER_METRICS_PORT);
const clientPort = ports.CLIENT_PORT;
const apiUrl = `http://localhost:${ports.API_PORT}`;
const keycloakUrl = `http://localhost:${ports.KEYCLOAK_PORT}`;
const mailpitUrl = `http://localhost:${ports.MAILPIT_UI_PORT}`;
const clientUrl = `http://localhost:${clientPort}`;
const databaseUrl = `postgres://${stack.POSTGRES_USER}:${stack.POSTGRES_PASSWORD}@127.0.0.1:${ports.POSTGRES_PORT}/${stack.POSTGRES_DB}`;
const s3Endpoint = `http://127.0.0.1:${ports.MINIO_PORT}`;
const whisperBaseUrl =
  whisperMode === "real"
    ? `http://127.0.0.1:${ports.WHISPER_PORT}/v1`
    : `http://127.0.0.1:${mockWhisperPort}/v1`;
// One name for the stub's model, shared by the worker and the stub: the worker checks on startup
// that its configured model is installed, so the two have to agree.
const mockWhisperModel = "mock-tiny";

// The issuer as the browser sees it. Both Keycloak (`KC_HOSTNAME`) and the API's public issuer
// check carry the port, so they follow this run's Keycloak port rather than the template's.
Object.assign(process.env, {
  KEYCLOAK_PUBLIC_URL: keycloakUrl,
  OIDC_PUBLIC_ISSUER_URL: `${keycloakUrl}/realms/quorum`,
});
stack.KEYCLOAK_PUBLIC_URL = keycloakUrl;
stack.OIDC_PUBLIC_ISSUER_URL = `${keycloakUrl}/realms/quorum`;

const composeArgs = [
  "compose",
  "-p",
  projectName,
  "--env-file",
  "e2e/e2e.env",
  "-f",
  "docker-compose.yml",
  "-f",
  "e2e/docker-compose.e2e.yml",
];

const composeServices = ["postgres", "mailpit", "keycloak", "minio", "minio-init", "api"];
if (whisperMode === "real") composeServices.push("whisper");

/** Long-running child processes this script owns and must clean up. */
const children = [];
/** Set once teardown starts killing children, so their exits stop counting as failures. */
let tearingDown = false;
/**
 * Rejects as soon as an essential background process dies. The run races it against every wait,
 * because a dead child plus a port an orphan still holds looks exactly like a healthy stack.
 */
const backgroundDeath = deferred();
/**
 * Cleared once the stack is up, answering, and has accepted this run's setup. While it is set, a
 * failure is a failure of the stack itself, and the containers are the only witnesses — see
 * `captureStackLogs`.
 */
let startingTheStack = true;
let exitCode = 0;

try {
  await Promise.race([main(), backgroundDeath.promise]);
} catch (error) {
  console.error(`[e2e] ${error instanceof Error ? error.message : String(error)}`);
  if (startingTheStack) captureStackLogs();
  exitCode = 1;
} finally {
  await teardown();
}

process.exit(exitCode);

async function main() {
  console.log(`[e2e] transcription backend: ${whisperMode}`);
  console.log(`[e2e] compose project: ${projectName}`);
  console.log(`[e2e] app ${clientUrl} · API ${apiUrl} · Keycloak ${keycloakUrl}`);
  console.log(`[e2e] traces and videos: e2e/test-results/${projectName}`);

  if (reuseStack) {
    console.log("[e2e] reusing the running stack");
  } else {
    await step("checking for stale stack volumes", assertVolumesMatchCredentials);
    await step("starting the stack", () =>
      run("docker", [...composeArgs, "up", "-d", "--build", ...composeServices], {
        cwd: repoRoot,
      }),
    );
  }

  await step("waiting for the stack", async () => {
    await waitForHttp(`${apiUrl}/healthz`, "the API");
    await waitForHttp(`${keycloakUrl}/realms/quorum`, "Keycloak");
    await waitForHttp(`${mailpitUrl}/api/v1/messages`, "the mail relay");
    await waitForHttp(`${s3Endpoint}/minio/health/live`, "MinIO");
    if (whisperMode === "real") await waitForHttp(`${whisperBaseUrl}/models`, "Whisper", 300_000);
  });

  await step("allowing this run's app origin in Keycloak", allowClientOrigin);

  if (whisperMode === "real") {
    // The worker installs its configured model on startup, so this step is not what makes the run
    // work — it is what keeps the download out of the suite's clock. Pulling it here means a cold
    // model volume costs time before the first test rather than inside it; the worker then finds
    // the model present and starts consuming immediately.
    await step("downloading the Whisper model", () =>
      fetchOk(`${whisperBaseUrl}/models/${stack.WHISPER_MODEL}`, { method: "POST" }, 900_000),
    );
  }
  // Everything above this line is the stack: containers coming up, and the two setup calls that
  // only a container can refuse. Everything below is the host — builds, the worker, the browser —
  // where a compose log has nothing to say. See `captureStackLogs`.
  startingTheStack = false;

  await step("building the workspaces", () =>
    run("pnpm", ["--filter", "@quorum/shared", "--filter", "@quorum/worker", "run", "build"], {
      cwd: repoRoot,
    }),
  );

  // The stub backend serves the summary endpoint in both modes, so it always runs.
  await step("starting the mock backend", async () => {
    await assertPortFree(mockWhisperPort, "the mock backend");
    background("mock-backend", process.execPath, [resolve(here, "mock-whisper.mjs")], {
      cwd: e2eDir,
      env: {
        ...process.env,
        MOCK_WHISPER_PORT: String(mockWhisperPort),
        MOCK_WHISPER_MODEL: mockWhisperModel,
      },
    });
    await waitForHttp(`http://127.0.0.1:${mockWhisperPort}/v1/models`, "the mock backend", 30_000);
  });

  await step("starting the transcription worker", async () => {
    await assertPortFree(workerMetricsPort, "the worker metrics endpoint");
    background("worker", process.execPath, ["worker/dist/index.js"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        LOG_LEVEL: process.env.WORKER_LOG_LEVEL ?? "warn",
        DATABASE_URL: databaseUrl,
        S3_ENDPOINT: s3Endpoint,
        S3_BUCKET: stack.S3_BUCKET,
        S3_ACCESS_KEY: stack.MINIO_ROOT_USER,
        S3_SECRET_KEY: stack.MINIO_ROOT_PASSWORD,
        WHISPER_BASE_URL: whisperBaseUrl,
        WHISPER_MODEL: whisperMode === "real" ? stack.WHISPER_MODEL : mockWhisperModel,
        // Summaries always go to the stub: the stack ships no LLM, and ADR-005 makes the endpoint
        // the only thing that varies, so a real one would only add a network dependency.
        SUMMARY_BASE_URL: `http://127.0.0.1:${mockWhisperPort}/v1`,
        SUMMARY_MODEL: "mock-summary",
        SUMMARY_API_KEY: "unused",
        // A retry that takes longer than a test's patience only turns a real failure into a
        // timeout, so the worker retries fast and gives up early here.
        WORKER_RETRY_LIMIT: "2",
        WORKER_RETRY_DELAY_SECONDS: "2",
        // Same reasoning for the startup model check. The shipped budget is sized for downloading
        // large-v3 over a slow line; here the model is either already in the volume or served by
        // the stub, so anything that takes longer than a minute is wedged. Failing fast turns that
        // into a dead worker the run reports, instead of specs timing out one by one against a
        // process whose whisper.model.* lines are invisible at this log level.
        WHISPER_MODEL_INSTALL_TIMEOUT_MS: "60000",
      },
    });
  });

  await step("building the PWA", () =>
    run("pnpm", ["--filter", "@quorum/client", "run", "build"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        // Empty: the app talks to its own origin, and `vite preview` proxies to the API. That is
        // the deployment shape (one reverse proxy in front of both), so no CORS is involved here
        // and none is needed in production either.
        VITE_API_BASE_URL: "",
        VITE_OIDC_ISSUER_URL: `${keycloakUrl}/realms/quorum`,
        VITE_OIDC_CLIENT_ID: stack.OIDC_CLIENT_ID,
        VITE_OIDC_SCOPE: "openid profile email",
      },
    }),
  );

  await step("serving the PWA", async () => {
    await assertPortFree(Number(clientPort), "the PWA");
    background(
      "client",
      "pnpm",
      [
        "--filter",
        "@quorum/client",
        "exec",
        "vite",
        "preview",
        "--port",
        String(clientPort),
        "--strictPort",
      ],
      { cwd: repoRoot, env: { ...process.env, QUORUM_PREVIEW_API_TARGET: apiUrl } },
    );
    await waitForHttp(clientUrl, "the PWA", 60_000);
  });

  await step("installing the browser", () =>
    run("pnpm", ["--filter", "@quorum/e2e", "exec", "playwright", "install", "chromium"], {
      cwd: repoRoot,
    }),
  );

  const testEnv = {
    ...process.env,
    E2E_CLIENT_URL: clientUrl,
    E2E_API_URL: apiUrl,
    E2E_KEYCLOAK_URL: keycloakUrl,
    E2E_MAILPIT_URL: mailpitUrl,
    E2E_DATABASE_URL: databaseUrl,
    E2E_S3_ENDPOINT: s3Endpoint,
    E2E_S3_BUCKET: stack.S3_BUCKET,
    E2E_S3_ACCESS_KEY: stack.MINIO_ROOT_USER,
    E2E_S3_SECRET_KEY: stack.MINIO_ROOT_PASSWORD,
    E2E_OIDC_CLIENT_ID: stack.OIDC_CLIENT_ID,
    E2E_WHISPER: whisperMode,
    E2E_MOCK_BACKEND_URL: `http://127.0.0.1:${mockWhisperPort}`,
    // The crash-recovery spec restarts the API container, and Playwright keeps this run's
    // artifacts apart from a concurrent run's — both need the project name.
    E2E_COMPOSE_PROJECT: projectName,
  };

  const passthrough = process.argv.slice(2);
  await run("pnpm", ["--filter", "@quorum/e2e", "exec", "playwright", "test", ...passthrough], {
    cwd: repoRoot,
    env: testEnv,
  });
}

/**
 * Writes the containers' own account of a failed startup next to this run's Playwright artifacts.
 *
 * WHY THIS EXISTS: teardown is `down -v`, and it runs on every exit including a failed one. A
 * stack that does not come up is therefore deleted seconds after it fails, together with the one
 * thing that could explain it — and on a runner there is no stack left to attach to afterwards.
 * All anyone gets is compose's single line naming the service that gave up, which says nothing
 * about why. So the logs are copied out first, into the directory CI already uploads on failure.
 *
 * Everything here is best effort by design: this runs while an error is on its way out, and a
 * problem collecting evidence must never replace the error it was collecting evidence about.
 */
function captureStackLogs() {
  try {
    const directory = resolve(e2eDir, "test-results", projectName, "stack");
    mkdirSync(directory, { recursive: true });

    const logsOf = (service) => [
      ...composeArgs,
      "logs",
      "--no-color",
      "--timestamps",
      ...(service === undefined ? [] : [service]),
    ];
    // The whole stack in one file, so the order of events across services stays readable, plus a
    // file per service that exited badly — that one is what a reader opens first.
    const wanted = [
      ["containers.txt", [...composeArgs, "ps", "--all"]],
      ["all-services.log", logsOf()],
      ...servicesThatFailed().map((service) => [`${service}.log`, logsOf(service)]),
    ];
    const written = wanted
      .map(([name, args]) => writeCommandOutput(directory, name, args))
      .filter((label) => label !== null);

    if (written.length === 0) {
      console.error("[e2e] the stack left no logs behind — it never got as far as a container");
      return;
    }
    console.error(
      `[e2e] the stack's logs are in e2e/test-results/${projectName}/stack (${written.join(", ")})`,
    );
  } catch (error) {
    console.error(
      `[e2e] could not collect the stack's logs: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * The services whose containers exited non-zero or are unhealthy — the ones worth their own file.
 * A one-shot service that did its job exits 0 and is correctly not named here.
 */
function servicesThatFailed() {
  // `composeArgs` names the compose files by relative path, so this has to run where they are.
  const output = capture("docker", [...composeArgs, "ps", "--all", "--format", "json"], {
    cwd: repoRoot,
  });
  if (output === null) return [];
  const failed = new Set();
  for (const line of output.split("\n")) {
    if (line.trim() === "") continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    // Compose prints one object per line; older versions print a single array instead.
    for (const container of Array.isArray(parsed) ? parsed : [parsed]) {
      if (typeof container?.Service !== "string") continue;
      if (container.ExitCode !== 0 || container.Health === "unhealthy") {
        failed.add(container.Service);
      }
    }
  }
  return [...failed];
}

/**
 * Writes one command's output — both streams, because the interesting part is often on stderr —
 * and returns how it should be described, or null when there was nothing to write.
 *
 * A command that failed still leaves its file: when the Docker daemon has gone away, its complaint
 * IS the evidence. What must not happen is announcing a captured log that is really a page of
 * client errors, so the exit status travels with the name and lands in the file too.
 */
function writeCommandOutput(directory, name, args) {
  const result = spawnSync("docker", args, {
    cwd: repoRoot,
    encoding: "utf8",
    // A stack that failed to start can still have produced megabytes of log, and Node's default
    // of one megabyte would truncate it into uselessness.
    maxBuffer: 64 * 1024 * 1024,
  });

  let failure = null;
  if (result.error !== undefined) failure = `docker did not run: ${result.error.message}`;
  else if (result.status !== 0) failure = `docker exited ${result.signal ?? result.status}`;

  const body = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (failure === null) {
    if (body.trim() === "") return null;
    writeFileSync(resolve(directory, name), body);
    return name;
  }
  writeFileSync(
    resolve(directory, name),
    `${body}\n[e2e] this capture is incomplete: ${failure}\n`,
  );
  return `${name} — incomplete, ${failure}`;
}

async function teardown() {
  tearingDown = true;
  for (const child of children.reverse()) {
    if (child.process.exitCode === null && child.process.signalCode === null) {
      child.process.kill("SIGTERM");
    }
  }
  await Promise.all(
    children.map((child) =>
      child.process.exitCode === null ? once(child.process, "exit").catch(() => undefined) : null,
    ),
  );

  if (keepStack || reuseStack) {
    console.log(`[e2e] leaving the stack up (${apiUrl})`);
    console.log(`[e2e] reuse it with E2E_REUSE_STACK=1 E2E_PROJECT=${projectName} pnpm run e2e`);
    return;
  }
  // Volumes go too: every run starts from an empty bucket and an empty database, which is what
  // makes the storage assertions unambiguous. `-p` is this run's own project, so a concurrent run
  // is untouched.
  await run("docker", [...composeArgs, "down", "-v", "--remove-orphans"], {
    cwd: repoRoot,
  }).catch(() => console.error("[e2e] stack teardown failed"));
  // The ports belonged to the stack that just went away.
  rmSync(portsFile(projectName), { force: true });
}

/**
 * The compose project name — this run's namespace for containers, networks and volumes.
 *
 * A generated name per run is the default, because teardown says `down -v` and a shared name
 * makes that a second run's outage. The reuse loop is the deliberate exception: `E2E_REUSE_STACK`
 * has to find a stack again, so it needs a name that was decided before the run. Either give one
 * with `E2E_PROJECT`, or let a run that intends to be found again (`E2E_KEEP_STACK`) fall back to
 * the fixed `quorum-e2e-keep` — one stable, obvious slot per machine, which is what an inner loop
 * wants and what a parallel run must never pick by accident.
 */
function resolveProjectName() {
  const given = process.env.E2E_PROJECT;
  if (given !== undefined && given !== "") {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(given)) {
      throw new Error(
        `E2E_PROJECT must be lowercase letters, digits, dashes and underscores (got \`${given}\`) — ` +
          `compose rejects anything else as a project name.`,
      );
    }
    return given;
  }
  if (keepStack || reuseStack) return "quorum-e2e-keep";
  return `quorum-e2e-${randomBytes(4).toString("hex")}`;
}

/** Where this project's chosen ports are remembered, so a reusing run finds the same stack. */
function portsFile(project) {
  return resolve(e2eDir, `.ports.${project}.json`);
}

/**
 * This run's host ports.
 *
 * A reusing run reads back what the stack was actually started with — the containers publish
 * those, and nothing can move them now. Otherwise every port is taken fresh from the ephemeral
 * range, so the run cannot collide with a demo stack, a development stack, or another suite run.
 * A port named in the environment is honored instead and only checked: pinning one is how a
 * developer gets a predictable URL, and a fixed port that something else holds stays a fail-fast
 * error naming the holder rather than a run against the wrong process.
 */
async function resolvePorts() {
  const path = portsFile(projectName);
  if (reuseStack) {
    if (!existsSync(path)) {
      throw new Error(
        `E2E_REUSE_STACK=1 asks to reuse the \`${projectName}\` stack, but ${path} is missing, so ` +
          `the ports it publishes are unknown. Start it once without E2E_REUSE_STACK (add ` +
          `E2E_KEEP_STACK=1 to keep it), then reuse it.`,
      );
    }
    return JSON.parse(readFileSync(path, "utf8"));
  }

  const chosen = {};
  // Held open together, then released as a block: overlapping listeners are what keeps the
  // kernel from handing the same free port to two of these.
  const held = [];
  try {
    for (const name of portVariables) {
      const pinned = process.env[name];
      if (pinned !== undefined && pinned !== "") {
        await assertPortFree(Number.parseInt(pinned, 10), `${name}, pinned in the environment`);
        chosen[name] = pinned;
        continue;
      }
      const server = createServer();
      await new Promise((done, fail) => {
        server.once("error", fail);
        // Bound on every interface, because Docker publishes the container ports there and a
        // port free only on the loopback address would still collide.
        server.listen({ port: 0, host: "0.0.0.0", exclusive: true }, done);
      });
      held.push(server);
      chosen[name] = String(server.address().port);
    }
  } finally {
    for (const server of held) server.close();
  }
  writeFileSync(path, `${JSON.stringify(chosen, null, 2)}\n`);
  return chosen;
}

/**
 * Teaches this run's Keycloak about the origin the PWA is actually served from.
 *
 * The committed realm lists fixed redirect URIs (4173 and friends), and a run that took a free
 * port is not on that list. Patching the throwaway stack keeps the isolation without turning the
 * shared realm file — which development and production also read — into a list of ports.
 */
async function allowClientOrigin() {
  const token = await keycloakAdminToken();
  const clients = await keycloakAdmin(`/clients?clientId=${stack.OIDC_CLIENT_ID}`, token);
  const client = clients[0];
  if (client === undefined) {
    throw new Error(`Keycloak has no \`${stack.OIDC_CLIENT_ID}\` client to point at ${clientUrl}`);
  }

  const redirectUris = [...new Set([...(client.redirectUris ?? []), `${clientUrl}/*`])];
  const webOrigins = [...new Set([...(client.webOrigins ?? []), clientUrl])];
  const logout = client.attributes?.["post.logout.redirect.uris"] ?? "";
  const logoutUris = [...new Set([...logout.split("##").filter(Boolean), `${clientUrl}/*`])].join(
    "##",
  );

  await keycloakAdmin(`/clients/${client.id}`, token, {
    method: "PUT",
    body: {
      ...client,
      redirectUris,
      webOrigins,
      attributes: { ...client.attributes, "post.logout.redirect.uris": logoutUris },
    },
  });
}

async function keycloakAdminToken() {
  const response = await fetch(`${keycloakUrl}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: stack.KEYCLOAK_ADMIN ?? "admin",
      password: stack.KEYCLOAK_ADMIN_PASSWORD,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`Keycloak refused the admin login (${response.status})`);
  }
  return (await response.json()).access_token;
}

async function keycloakAdmin(path, token, { method = "GET", body } = {}) {
  const response = await fetch(
    `${keycloakUrl}/admin/realms/${stack.KEYCLOAK_REALM ?? "quorum"}${path}`,
    {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Keycloak admin ${method} ${path} answered ${response.status}`);
  }
  return response.status === 204 ? undefined : await response.json().catch(() => undefined);
}

async function step(label, action) {
  const started = Date.now();
  console.log(`[e2e] ${label}…`);
  await action();
  console.log(`[e2e] ${label} — done in ${Math.round((Date.now() - started) / 1000)}s`);
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? code})`));
    });
  });
}

function background(name, command, args, options = {}) {
  const child = spawn(command, args, { stdio: "inherit", ...options });
  children.push({ name, process: child });
  child.on("error", (error) => {
    backgroundDeath.reject(new Error(`${name} could not be started: ${error.message}`));
  });
  child.on("exit", (code, signal) => {
    if (tearingDown || signal === "SIGTERM") return;
    // A background process that dies mid-run fails the run: the alternative is polling whatever
    // else holds its port and testing a stale build.
    backgroundDeath.reject(new Error(`${name} exited unexpectedly (${signal ?? code})`));
  });
  return child;
}

/** A promise plus its settle functions, so an event handler can fail the run from outside. */
function deferred() {
  let reject;
  const promise = new Promise((_, rejectPromise) => {
    reject = rejectPromise;
  });
  // Nothing awaits this promise before the race in the entry block, and the race keeps a handler
  // attached afterwards, so a late rejection is never unhandled.
  return { promise, reject };
}

/**
 * Refuses to start a process on a port something else already holds. Without this the new child
 * dies with EADDRINUSE while the health check happily answers from the leftover one.
 */
async function assertPortFree(port, what) {
  const server = createServer();
  try {
    await new Promise((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen({ port, host: "0.0.0.0", exclusive: true }, resolvePromise);
    });
  } catch (error) {
    const owner = describePortOwner(port);
    throw new Error(
      `port ${port} (${what}) is already in use${owner}. ` +
        `Whatever answers there would be tested instead of this build. Either free it ` +
        `(\`kill $(lsof -ti :${port})\`) or leave the port unpinned and let the run take a free ` +
        `one. [${error.code ?? error.message}]`,
      { cause: error },
    );
  }
  await new Promise((resolvePromise) => server.close(resolvePromise));
}

/** Best effort: `lsof` is absent on plenty of machines, and an unnamed port is still an error. */
function describePortOwner(port) {
  const pids = capture("lsof", ["-ti", `:${port}`]);
  if (pids === null || pids.trim() === "") return "";
  const list = pids.trim().split("\n").join(", ");
  const command = capture("ps", ["-o", "command=", "-p", pids.trim().split("\n")[0]]);
  const name = command === null || command.trim() === "" ? "" : ` — ${command.trim()}`;
  return ` (pid ${list}${name})`;
}

/**
 * Volumes of this project outlive a run left up with `E2E_KEEP_STACK=1` or a failed teardown —
 * which only a named project (`E2E_PROJECT`, or the reuse loop's fixed name) can inherit, since a
 * generated name is new every time. They carry the credentials of that run, so pairing them with
 * freshly generated ones only makes Keycloak report a password failure against a database it
 * cannot open.
 */
async function assertVolumesMatchCredentials() {
  if (!credentialsAreNew) return;
  const volumes = capture("docker", [
    "volume",
    "ls",
    "--filter",
    `label=com.docker.compose.project=${projectName}`,
    "--quiet",
  ]);
  if (volumes === null || volumes.trim() === "") return;
  throw new Error(
    `the \`${projectName}\` stack still has volumes (${volumes.trim().split("\n").join(", ")}) from an ` +
      `earlier run, but e2e/.stack.env was regenerated this run, so their credentials no longer ` +
      `match and Keycloak would fail to open its database. Remove them with ` +
      `\`docker compose ${composeArgs.slice(1).join(" ")} down -v\` and run again.`,
  );
}

/** Synchronous command output, or null when the command is missing or fails. */
function capture(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}

async function waitForHttp(url, what, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error(`${what} did not become ready at ${url}`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_000));
  }
}

async function fetchOk(url, options, timeoutMs) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}: ${await response.text()}`);
}

/**
 * The stack's environment file. It is a gitignored copy of the committed template, so a machine
 * that needs a different port changes it without producing a diff — and so nothing env-shaped is
 * ever tracked in a public repository.
 */
function localEnvFile() {
  const path = resolve(e2eDir, "e2e.env");
  if (!existsSync(path)) copyFileSync(resolve(e2eDir, "e2e.env.example"), path);
  return path;
}

/**
 * Credentials for the throwaway stack.
 *
 * They are generated on the first run and kept in a gitignored file so repeated runs (and a
 * Playwright invocation against a stack that is already up) agree on them. Nothing here is
 * committed: a test stack needs no fixed passwords, and committed ones only teach everyone to
 * wave secret scanners through.
 */
function loadCredentials() {
  const path = resolve(e2eDir, ".stack.env");
  if (existsSync(path)) return parseEnvFile(path);

  credentialsAreNew = true;
  const secret = () => randomBytes(24).toString("base64url");
  const generated = {
    POSTGRES_PASSWORD: secret(),
    MINIO_ROOT_PASSWORD: secret(),
    // MinIO's built-in KMS wants `<key-name>:<base64 32 bytes>`.
    MINIO_KMS_SECRET_KEY: `quorum-e2e-key:${randomBytes(32).toString("base64")}`,
    KEYCLOAK_ADMIN_PASSWORD: secret(),
    KEYCLOAK_DB_PASSWORD: secret(),
  };

  try {
    // `wx`: two runs starting at once on a machine that has no credentials yet would otherwise
    // both write, and the loser's stack would come up with passwords the file no longer names.
    writeFileSync(
      path,
      [
        "# Generated by e2e/scripts/run.mjs for the throwaway end-to-end stacks. Gitignored.",
        "# Delete this file to roll the credentials; the stack is recreated with them on the next run.",
        ...Object.entries(generated).map(([key, value]) => `${key}=${value}`),
        "",
      ].join("\n"),
      { mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    credentialsAreNew = false;
    return parseEnvFile(path);
  }
  return generated;
}

/** Minimal `KEY=value` reader — enough for the flat file the suite ships. */
function parseEnvFile(path) {
  const values = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator === -1) continue;
    values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return values;
}
