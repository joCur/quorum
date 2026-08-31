// Single entry point for the end-to-end suite: `pnpm run e2e` from the repository root.
//
// It owns the whole run — stack up, application processes, tests, teardown — because the suite
// spans four processes and a browser, and a developer should not have to assemble that by hand.
//
// What runs where:
//   * compose (project `quorum-e2e`): Postgres, Keycloak, MinIO, the API, and Whisper on request
//   * host: the transcription worker, the built PWA, and Playwright
//
// The worker and the PWA run on the host on purpose. The worker has no image yet, and building
// the PWA here is what lets the suite point it at this stack's API and issuer without a second
// set of committed configuration files.
//
// Environment:
//   E2E_WHISPER=mock|real   mock (default) uses the stub transcription endpoint; real starts the
//                           CPU Whisper container with the smallest model
//   E2E_KEEP_STACK=1        leave the stack running after the tests, for debugging
//   E2E_REUSE_STACK=1       assume the stack is already up and skip `compose up`
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const here = dirname(fileURLToPath(import.meta.url));
const e2eDir = resolve(here, "..");
const repoRoot = resolve(e2eDir, "..");

const credentials = loadCredentials();
const stack = { ...parseEnvFile(localEnvFile()), ...credentials };
// Compose reads these from the process environment, which takes precedence over `--env-file` —
// that is how the generated credentials reach the containers.
Object.assign(process.env, credentials);

const whisperMode = process.env.E2E_WHISPER === "real" ? "real" : "mock";
const keepStack = process.env.E2E_KEEP_STACK === "1";
const reuseStack = process.env.E2E_REUSE_STACK === "1";

const mockWhisperPort = Number.parseInt(process.env.MOCK_WHISPER_PORT ?? "8123", 10);
const clientPort = stack.CLIENT_PORT ?? "4173";
const apiUrl = `http://localhost:${stack.API_PORT}`;
const keycloakUrl = `http://localhost:${stack.KEYCLOAK_PORT}`;
const mailpitUrl = `http://localhost:${stack.MAILPIT_UI_PORT ?? "8125"}`;
const clientUrl = `http://localhost:${clientPort}`;
const databaseUrl = `postgres://${stack.POSTGRES_USER}:${stack.POSTGRES_PASSWORD}@127.0.0.1:${stack.POSTGRES_PORT}/${stack.POSTGRES_DB}`;
const s3Endpoint = `http://127.0.0.1:${stack.MINIO_PORT}`;
const whisperBaseUrl =
  whisperMode === "real"
    ? `http://127.0.0.1:${stack.WHISPER_PORT}/v1`
    : `http://127.0.0.1:${mockWhisperPort}/v1`;

const composeArgs = [
  "compose",
  "-p",
  "quorum-e2e",
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
let exitCode = 0;

try {
  await main();
} catch (error) {
  console.error(`[e2e] ${error instanceof Error ? error.message : String(error)}`);
  exitCode = 1;
} finally {
  await teardown();
}

process.exit(exitCode);

async function main() {
  console.log(`[e2e] transcription backend: ${whisperMode}`);

  if (reuseStack) {
    console.log("[e2e] reusing the running stack");
  } else {
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

  if (whisperMode === "real") {
    // speaches serves only models it already has on disk, and answers 404 for anything else
    // rather than fetching it mid-transcription. Pulling it here means the download happens once,
    // outside any test's timeout, and is cached in the `whisper-models` volume afterwards.
    await step("downloading the Whisper model", () =>
      fetchOk(`${whisperBaseUrl}/models/${stack.WHISPER_MODEL}`, { method: "POST" }, 900_000),
    );
  }

  await step("building the workspaces", () =>
    run("pnpm", ["--filter", "@quorum/shared", "--filter", "@quorum/worker", "run", "build"], {
      cwd: repoRoot,
    }),
  );

  // The stub backend serves the summary endpoint in both modes, so it always runs.
  await step("starting the mock backend", async () => {
    background("mock-backend", process.execPath, [resolve(here, "mock-whisper.mjs")], {
      cwd: e2eDir,
      env: { ...process.env, MOCK_WHISPER_PORT: String(mockWhisperPort) },
    });
    await waitForHttp(`http://127.0.0.1:${mockWhisperPort}/v1/models`, "the mock backend", 30_000);
  });

  await step("starting the transcription worker", async () => {
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
        WHISPER_MODEL: whisperMode === "real" ? stack.WHISPER_MODEL : "mock-tiny",
        // Summaries always go to the stub: the stack ships no LLM, and ADR-005 makes the endpoint
        // the only thing that varies, so a real one would only add a network dependency.
        SUMMARY_BASE_URL: `http://127.0.0.1:${mockWhisperPort}/v1`,
        SUMMARY_MODEL: "mock-summary",
        SUMMARY_API_KEY: "unused",
        // A retry that takes longer than a test's patience only turns a real failure into a
        // timeout, so the worker retries fast and gives up early here.
        WORKER_RETRY_LIMIT: "2",
        WORKER_RETRY_DELAY_SECONDS: "2",
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
  };

  const passthrough = process.argv.slice(2);
  await run("pnpm", ["--filter", "@quorum/e2e", "exec", "playwright", "test", ...passthrough], {
    cwd: repoRoot,
    env: testEnv,
  });
}

async function teardown() {
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
    return;
  }
  // Volumes go too: every run starts from an empty bucket and an empty database, which is what
  // makes the storage assertions unambiguous.
  await run("docker", [...composeArgs, "down", "-v", "--remove-orphans"], {
    cwd: repoRoot,
  }).catch(() => console.error("[e2e] stack teardown failed"));
}

// ---- helpers --------------------------------------------------------------

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
  child.on("exit", (code, signal) => {
    if (code !== 0 && signal !== "SIGTERM") {
      console.error(`[e2e] ${name} exited unexpectedly (${signal ?? code})`);
    }
  });
  return child;
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

  const secret = () => randomBytes(24).toString("base64url");
  const generated = {
    POSTGRES_PASSWORD: secret(),
    MINIO_ROOT_PASSWORD: secret(),
    // MinIO's built-in KMS wants `<key-name>:<base64 32 bytes>`.
    MINIO_KMS_SECRET_KEY: `quorum-e2e-key:${randomBytes(32).toString("base64")}`,
    KEYCLOAK_ADMIN_PASSWORD: secret(),
    KEYCLOAK_DB_PASSWORD: secret(),
  };

  writeFileSync(
    path,
    [
      "# Generated by e2e/scripts/run.mjs for the throwaway `quorum-e2e` stack. Gitignored.",
      "# Delete this file to roll the credentials; the stack is recreated with them on the next run.",
      ...Object.entries(generated).map(([key, value]) => `${key}=${value}`),
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
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
