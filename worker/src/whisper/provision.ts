import { z } from "zod";
import { createFetchWithTimeouts } from "../http/timeout-fetch.js";

/**
 * Puts the configured transcription model on the backend's disk before the
 * worker consumes its first job.
 *
 * WHY THIS EXISTS: the backend separates two things that sound like one.
 * Loading a model into memory is automatic and happens on demand; downloading
 * it to disk is not — a model the backend has never fetched is answered with
 * `404 Model '…' is not installed locally`, which the error taxonomy classifies
 * as terminal, so the very first transcription of a fresh deployment
 * dead-letters instead of retrying. Provisioning by hand after every install is
 * a step nobody remembers, and the failure it produces looks like a bug in the
 * pipeline rather than a missing download.
 *
 * WHY IT LIVES IN THE WORKER: the worker is the one component that knows both
 * halves of the answer — the backend base URL and the model name (ADR-005) —
 * and it is the component whose first action would otherwise fail. Anything
 * else (a compose init container, a shell script) would have to be repeated per
 * profile and could not be tested. Here it runs identically on the CPU and GPU
 * profiles, because those differ only in how the backend is scheduled.
 *
 * WHAT IT ASSUMES, and what it does when the assumption fails, is written down
 * in ADR-008: only the OpenAI-compatible model listing is expected, the download
 * route is optional, and neither is a precondition for transcription.
 *
 * HOW IT TALKS: over the transport of `http/timeout-fetch.ts`, never the global
 * `fetch`. The download route answers when the bytes are on disk and not before,
 * so a multi-gigabyte model holds the connection open without a byte of response
 * for as long as it takes — and undici's built-in 300-second headers timeout
 * ignores the `AbortController` entirely. On the global transport the flagship
 * case, `large-v3`, would therefore fail every attempt at exactly five minutes,
 * each failure restacking another download on the backend until the budget was
 * spent. The dispatcher is what makes the configured budget the real one.
 */

/** The OpenAI-compatible listing shape; extra fields are ignored on purpose. */
const ModelListSchema = z.object({
  data: z.array(z.object({ id: z.string() })),
});

/**
 * Per-request timeout for the cheap listing calls.
 *
 * A constant rather than an option: the listing is a small JSON document that
 * any healthy backend produces immediately, and a backend too busy to answer it
 * in this long is one the retry loop should come back to rather than one to keep
 * waiting on. The download has its own budget, which is the configurable one.
 */
const PROBE_TIMEOUT_MS = 15_000;

/**
 * How long the same "there is no such route" answer has to persist before it is
 * believed.
 *
 * A single 404 on the model listing means one of two very different things: a
 * backend that genuinely has no model management (host-native whisper.cpp), or a
 * reverse proxy whose upstream route is not registered yet, or a base URL
 * missing its `/v1`. Concluding the first from one response is how provisioning
 * would silently switch itself off in exactly the deployments that need it, so
 * the answer has to survive a window before it counts.
 *
 * Capped at half the overall budget so that collecting this evidence can never
 * be what exhausts it — reaching the deadline then always means the backend was
 * unreachable or erroring, never merely minimal.
 */
const UNSUPPORTED_CONFIRMATION_MS = 60_000;

/** …and it has to be seen this often, so one slow answer in a flap cannot decide it. */
const UNSUPPORTED_CONFIRMATION_ATTEMPTS = 3;

/**
 * Grace for the listing to catch up with a download that reported success.
 *
 * The download route answers when the bytes are on disk, but nothing in the API
 * promises that the listing is updated in the same instant, and an ID may come
 * back canonicalized. Throwing on the first read would turn a successful
 * download into a restart loop over a race.
 */
const VERIFY_GRACE_MS = 30_000;

/** Narrow port so the provisioner can be exercised without a real logger. */
export interface ProvisioningLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  fatal(fields: Record<string, unknown>, message: string): void;
}

/**
 * The event an operator is sent looking for by name when the worker will not
 * start. Named here rather than at the call site so it cannot drift from the
 * throw it accompanies.
 */
export const PROVISIONING_FAILED_EVENT = "whisper.model.provisioning-failed";

export type ModelProvisioningOutcome =
  /** Turned off by configuration; the backend is not contacted. */
  | { status: "disabled" }
  /** The backend exposes no model listing we recognize, so nothing was done. */
  | { status: "unsupported"; detail: string }
  /** The model was already on disk — the ordinary case on every restart. */
  | { status: "present" }
  /** The model was missing and has been downloaded. */
  | { status: "installed"; durationMs: number };

export type ModelProvisioningFailure =
  /** The backend never answered within the budget. */
  | "backend-unreachable"
  /** The backend refused our credentials — a configuration error, not an outage. */
  | "unauthorized"
  /** The backend does not know this model ID — also a configuration error. */
  | "model-unknown"
  /** The download was attempted and kept failing. */
  | "install-failed"
  /** The download reported success but the model never showed up in the listing. */
  | "not-installed";

export class ModelProvisioningError extends Error {
  readonly reason: ModelProvisioningFailure;
  readonly model: string;

  constructor(
    reason: ModelProvisioningFailure,
    model: string,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ModelProvisioningError";
    this.reason = reason;
    this.model = model;
  }
}

export interface EnsureWhisperModelOptions {
  /** Base URL including the `/v1` suffix — the same one the client uses. */
  baseUrl: string;
  /** A full model ID, e.g. `Systran/faster-whisper-small`. */
  model: string;
  apiKey?: string | undefined;
  logger: ProvisioningLogger;
  /** Set false to leave provisioning to an operator. */
  enabled?: boolean;
  /** Budget for the whole step: waiting for the backend plus the download. */
  timeoutMs?: number;
  /** Pause between attempts while the backend is still starting. */
  retryDelayMs?: number;
  /** How often a running download reports that it is still running. */
  progressIntervalMs?: number;
  /**
   * Overrides the transport. The default one carries the timeouts derived from
   * `timeoutMs`, so a substitute is for tests only — a plain global `fetch`
   * would reinstate undici's five-minute headers timeout, which every download
   * of a large model outlives.
   */
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface ProvisioningContext {
  baseUrl: string;
  model: string;
  logger: ProvisioningLogger;
  deadline: number;
  retryDelayMs: number;
  progressIntervalMs: number;
  confirmUnsupportedMs: number;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  request: (path: string, method: "GET" | "POST", timeoutMs: number) => Promise<Response>;
}

/**
 * Ensures the configured model is installed, and resolves only once it is.
 *
 * Idempotent: a restart with the model already in the cache volume costs one
 * listing request and returns `present`.
 *
 * Throws when the model cannot be made available, and logs
 * `whisper.model.provisioning-failed` on the way out. The caller is expected to
 * let the throw travel: a worker that consumes transcribe jobs it cannot serve
 * turns one operator-visible startup error into a dead-lettered job for every
 * user who records something.
 *
 * The line is written here rather than at the call site so that it cannot be
 * forgotten and cannot arrive late. It names the model and the backend — which
 * the generic startup-failure line the lifecycle guard writes does not — and
 * emitting it before the throw is what puts it above that line in the log,
 * where an operator reading top-down meets the specific reason first.
 */
export async function ensureWhisperModel(
  options: EnsureWhisperModelOptions,
): Promise<ModelProvisioningOutcome> {
  try {
    return await provision(options);
  } catch (error) {
    options.logger.fatal(
      {
        event: PROVISIONING_FAILED_EVENT,
        err: error,
        whisperModel: options.model,
        whisperBaseUrl: options.baseUrl,
      },
      "the configured transcription model is not available; not consuming jobs",
    );
    throw error;
  }
}

async function provision(options: EnsureWhisperModelOptions): Promise<ModelProvisioningOutcome> {
  const {
    model,
    apiKey,
    logger,
    enabled = true,
    timeoutMs = 45 * 60_000,
    retryDelayMs = 5_000,
    progressIntervalMs = 30_000,
    now = () => Date.now(),
    sleep = defaultSleep,
  } = options;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");
  // Built from the whole budget rather than from what is left at each call: the
  // dispatcher is a connection pool created once, and its header timeout is a
  // ceiling, not a schedule. The per-request `AbortController` below is set to
  // the remaining budget and is therefore always the limit that fires first,
  // which keeps an exceeded budget an abort instead of a transport-level error.
  const fetchImpl = options.fetchImpl ?? createFetchWithTimeouts(timeoutMs);

  if (!enabled) {
    logger.warn(
      {
        event: "whisper.model.provisioning-disabled",
        whisperModel: model,
        whisperBaseUrl: baseUrl,
      },
      "automatic model provisioning is off; the transcription backend must already hold this model",
    );
    return { status: "disabled" };
  }

  const context: ProvisioningContext = {
    baseUrl,
    model,
    logger,
    deadline: now() + timeoutMs,
    retryDelayMs,
    progressIntervalMs,
    confirmUnsupportedMs: Math.min(UNSUPPORTED_CONFIRMATION_MS, Math.floor(timeoutMs / 2)),
    now,
    sleep,
    request: async (path, method, requestTimeoutMs) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
      try {
        return await fetchImpl(`${baseUrl}${path}`, {
          method,
          signal: controller.signal,
          ...(apiKey ? { headers: { authorization: `Bearer ${apiKey}` } } : {}),
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };

  const listing = await pollInstalledModels(context);
  if (listing.kind === "absent-route") {
    logger.warn(
      {
        event: "whisper.model.provisioning-unsupported",
        whisperModel: model,
        whisperBaseUrl: baseUrl,
        detail: listing.detail,
      },
      "the transcription backend has no model listing after repeated attempts; continuing without " +
        "provisioning. If that is not intended, check that WHISPER_BASE_URL carries the /v1 suffix " +
        "and reaches the backend itself; if it is, set WHISPER_MODEL_AUTO_INSTALL=false to say so",
    );
    return { status: "unsupported", detail: listing.detail };
  }

  const alreadyInstalled = matchModelId(context, listing.ids);
  if (alreadyInstalled) {
    logger.info(
      { event: "whisper.model.present", whisperModel: model, whisperBaseUrl: baseUrl },
      "the configured transcription model is installed",
    );
    return { status: "present" };
  }

  const startedAt = now();
  logger.info(
    {
      event: "whisper.model.install-started",
      whisperModel: model,
      whisperBaseUrl: baseUrl,
      installedModels: listing.ids,
    },
    "the configured transcription model is missing; downloading it before consuming jobs",
  );

  await installModel(context);
  await verifyInstalled(context);

  const durationMs = now() - startedAt;
  logger.info(
    {
      event: "whisper.model.installed",
      whisperModel: model,
      whisperBaseUrl: baseUrl,
      durationMs,
    },
    "the configured transcription model is installed",
  );
  return { status: "installed", durationMs };
}

/**
 * Reads the listing, retrying while the backend is unreachable or erroring, and
 * while a missing route has not yet proven itself missing.
 *
 * The retry is not politeness: the worker starts alongside the backend, so
 * "connection refused" on the first attempt is the normal case, not a fault.
 */
async function pollInstalledModels(
  context: ProvisioningContext,
): Promise<InstalledModels | AbsentRoute> {
  let announcedWait = false;
  let absentSince: number | undefined;
  let absentSeen = 0;

  for (;;) {
    const attempt = await readInstalledModels(context, PROBE_TIMEOUT_MS);
    if (attempt.kind === "list") return attempt;
    if (attempt.kind === "unauthorized") throw unauthorized(context, "reading the model listing");

    if (attempt.kind === "absent-route") {
      absentSince ??= context.now();
      absentSeen += 1;
      // Believed only once it has held for the confirmation window AND been
      // answered the same way often enough. A proxy that has not registered its
      // upstream yet answers exactly like a backend without the route, and only
      // time tells the two apart.
      if (
        absentSeen >= UNSUPPORTED_CONFIRMATION_ATTEMPTS &&
        context.now() - absentSince >= context.confirmUnsupportedMs
      ) {
        return attempt;
      }
    }

    if (context.now() >= context.deadline) {
      throw new ModelProvisioningError(
        "backend-unreachable",
        context.model,
        `the transcription backend at ${context.baseUrl} did not answer a usable model listing in time: ${attempt.detail}`,
      );
    }
    if (!announcedWait) {
      context.logger.info(
        {
          event: "whisper.model.waiting",
          whisperModel: context.model,
          whisperBaseUrl: context.baseUrl,
          detail: attempt.detail,
        },
        "waiting for the transcription backend to answer",
      );
      announcedWait = true;
    }
    await context.sleep(context.retryDelayMs);
  }
}

interface InstalledModels {
  kind: "list";
  ids: string[];
}
/** The backend says the route does not exist. Whether that is true takes time to establish. */
interface AbsentRoute {
  kind: "absent-route";
  detail: string;
}
interface Unauthorized {
  kind: "unauthorized";
  detail: string;
}
interface RetryLater {
  kind: "retry";
  detail: string;
}

async function readInstalledModels(
  context: ProvisioningContext,
  timeoutMs: number,
): Promise<InstalledModels | AbsentRoute | Unauthorized | RetryLater> {
  let response: Response;
  try {
    response = await context.request("/models", "GET", timeoutMs);
  } catch (error) {
    return { kind: "retry", detail: describe(error) };
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: "unauthorized", detail: `GET /models answered ${response.status}` };
  }
  if (response.status === 404 || response.status === 405 || response.status === 501) {
    return { kind: "absent-route", detail: `GET /models answered ${response.status}` };
  }
  if (!response.ok) {
    return { kind: "retry", detail: `GET /models answered ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "absent-route", detail: "GET /models did not return JSON" };
  }
  const parsed = ModelListSchema.safeParse(body);
  if (!parsed.success) {
    return {
      kind: "absent-route",
      detail: "GET /models did not return an OpenAI-compatible model list",
    };
  }
  return { kind: "list", ids: parsed.data.data.map((entry) => entry.id) };
}

/**
 * Downloads the model, retrying transient failures until the deadline.
 *
 * Two answers are separated from all the others because no amount of waiting
 * changes them: a 404 means the backend looked the ID up and does not have it —
 * a typo in `WHISPER_MODEL` — and a 401/403 means the credentials are wrong.
 * Retrying either would turn a one-line fix into a slow, silent startup.
 */
async function installModel(context: ProvisioningContext): Promise<void> {
  const path = `/models/${modelPath(context.model)}`;
  for (;;) {
    // The download answers only when it is finished, so its budget is whatever
    // is left of the overall one — and the transport's header timeout is sized
    // from that same number, not from a library default.
    const remaining = Math.max(context.deadline - context.now(), 1);
    let response: Response;
    try {
      response = await withProgressLogging(context, () => context.request(path, "POST", remaining));
    } catch (error) {
      await retryOrGiveUp(context, describe(error));
      continue;
    }

    if (response.ok) return;

    if (response.status === 401 || response.status === 403) {
      throw unauthorized(context, `downloading the model (POST answered ${response.status})`);
    }

    if (response.status === 404 || response.status === 400 || response.status === 422) {
      throw new ModelProvisioningError(
        "model-unknown",
        context.model,
        `the transcription backend does not know the model "${context.model}" (it answered ${response.status}${detailOf(await safeText(response))}). ` +
          `WHISPER_MODEL must be a full model ID such as Systran/faster-whisper-small, never a size like "small"; ` +
          `list the IDs this backend can fetch with GET ${context.baseUrl}/registry?task=automatic-speech-recognition`,
      );
    }

    await retryOrGiveUp(context, `POST ${path} answered ${response.status}`);
  }
}

function unauthorized(context: ProvisioningContext, whileDoing: string): ModelProvisioningError {
  return new ModelProvisioningError(
    "unauthorized",
    context.model,
    `the transcription backend at ${context.baseUrl} refused our credentials while ${whileDoing}. ` +
      `Set WHISPER_API_KEY to a token the backend accepts, or remove it if the backend expects none`,
  );
}

async function retryOrGiveUp(context: ProvisioningContext, detail: string): Promise<void> {
  if (context.now() >= context.deadline) {
    throw new ModelProvisioningError(
      "install-failed",
      context.model,
      `downloading the model "${context.model}" from ${context.baseUrl} did not succeed in time: ${detail}`,
    );
  }
  context.logger.warn(
    {
      event: "whisper.model.install-retry",
      whisperModel: context.model,
      whisperBaseUrl: context.baseUrl,
      detail,
    },
    "the model download failed; retrying",
  );
  await context.sleep(context.retryDelayMs);
}

/**
 * Confirms the model really is on disk after a download reported success.
 *
 * Polled rather than read once: the download answers when the bytes have
 * landed, and nothing promises the listing reflects that in the same instant. A
 * single read would turn that race — and a backend that installs
 * asynchronously — into a restart loop over a download that actually worked.
 *
 * A listing that cannot be read at all stays a warning rather than a failure.
 * At this point the download's own success is the better evidence, and refusing
 * to start over a flaky second request would be the worse outcome.
 */
async function verifyInstalled(context: ProvisioningContext): Promise<void> {
  const until = context.now() + VERIFY_GRACE_MS;

  for (;;) {
    const listing = await readInstalledModels(context, PROBE_TIMEOUT_MS);
    if (listing.kind === "list") {
      if (matchModelId(context, listing.ids)) return;
    } else if (listing.kind === "unauthorized") {
      throw unauthorized(context, "verifying the download");
    } else {
      context.logger.warn(
        {
          event: "whisper.model.verify-skipped",
          whisperModel: context.model,
          whisperBaseUrl: context.baseUrl,
          detail: listing.detail,
        },
        "could not re-read the model listing after the download; trusting the download's own result",
      );
      return;
    }
    if (context.now() >= until) {
      throw new ModelProvisioningError(
        "not-installed",
        context.model,
        `the transcription backend reported "${context.model}" as downloaded but never listed it as ` +
          `installed: after ${VERIFY_GRACE_MS}ms the listing still holds ${listing.ids.length} other model(s)`,
      );
    }
    await context.sleep(context.retryDelayMs);
  }
}

/**
 * Finds the configured model in a listing, tolerating a difference in case.
 *
 * Hugging Face IDs are written by people into an environment variable, and a
 * backend may hand back its own canonical spelling. Insisting on a byte-exact
 * match would re-download a model that is already there and then fail
 * verification on it forever. The mismatch is still worth saying out loud: the
 * transcription request itself sends the configured spelling, and a backend
 * stricter than this comparison would reject it.
 */
function matchModelId(context: ProvisioningContext, ids: string[]): string | undefined {
  const exact = ids.find((id) => id === context.model);
  if (exact) return exact;

  const wanted = context.model.trim().toLowerCase();
  const loose = ids.find((id) => id.trim().toLowerCase() === wanted);
  if (loose) {
    context.logger.warn(
      {
        event: "whisper.model.id-case-mismatch",
        whisperModel: context.model,
        backendModelId: loose,
        whisperBaseUrl: context.baseUrl,
      },
      "the backend spells the configured model differently; set WHISPER_MODEL to the backend's " +
        "spelling, because transcription requests send the configured one verbatim",
    );
  }
  return loose;
}

/**
 * Says the download is still running while it is.
 *
 * The request is a single blocking call that can take tens of minutes for the
 * large models, and a startup that prints nothing for that long is
 * indistinguishable from one that has hung.
 */
async function withProgressLogging<T>(
  context: ProvisioningContext,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = context.now();
  const timer = setInterval(() => {
    context.logger.info(
      {
        event: "whisper.model.install-progress",
        whisperModel: context.model,
        whisperBaseUrl: context.baseUrl,
        elapsedMs: context.now() - startedAt,
      },
      "still downloading the transcription model",
    );
  }, context.progressIntervalMs);
  // Nothing should be kept alive by a heartbeat.
  timer.unref();
  try {
    return await operation();
  } finally {
    clearInterval(timer);
  }
}

/** Keeps the slash in `owner/name` a path separator, escaping everything else. */
function modelPath(model: string): string {
  return model
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function detailOf(text: string): string {
  return text ? `: ${text}` : "";
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).trim().slice(0, 300);
  } catch {
    return "";
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
