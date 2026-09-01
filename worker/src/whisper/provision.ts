import { z } from "zod";

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
 * WHAT IT ASSUMES: only the OpenAI-compatible model listing (`GET /models`) is
 * required. Installation (`POST /models/{id}`) and the registry are extensions
 * that the current backend offers and a leaner one may not — a backend without
 * a recognizable listing is left alone with a warning rather than blocked,
 * which is what keeps host-native serving (whisper.cpp, mlx-whisper) usable.
 */

/** The OpenAI-compatible listing shape; extra fields are ignored on purpose. */
const ModelListSchema = z.object({
  data: z.array(z.object({ id: z.string() })),
});

/** Narrow port so the provisioner can be exercised without a real logger. */
export interface ProvisioningLogger {
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
}

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
  /** The backend does not know this model ID — a configuration error. */
  | "model-unknown"
  /** The download was attempted and kept failing. */
  | "install-failed"
  /** The download reported success but the model is still not listed. */
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
  /** Per-request timeout for the cheap listing calls. */
  probeTimeoutMs?: number;
  /** Pause between attempts while the backend is still starting. */
  retryDelayMs?: number;
  /** How often a running download reports that it is still running. */
  progressIntervalMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface ProvisioningContext {
  baseUrl: string;
  model: string;
  logger: ProvisioningLogger;
  deadline: number;
  probeTimeoutMs: number;
  retryDelayMs: number;
  progressIntervalMs: number;
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
 * Throws `ModelProvisioningError` when the model cannot be made available. The
 * caller is expected to treat that as fatal — a worker that consumes transcribe
 * jobs it cannot serve turns one operator-visible startup failure into a
 * dead-lettered job for every user who records something.
 */
export async function ensureWhisperModel(
  options: EnsureWhisperModelOptions,
): Promise<ModelProvisioningOutcome> {
  const {
    model,
    apiKey,
    logger,
    enabled = true,
    timeoutMs = 45 * 60_000,
    probeTimeoutMs = 15_000,
    retryDelayMs = 5_000,
    progressIntervalMs = 30_000,
    fetchImpl = fetch,
    now = () => Date.now(),
    sleep = defaultSleep,
  } = options;
  const baseUrl = options.baseUrl.replace(/\/+$/, "");

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
    probeTimeoutMs,
    retryDelayMs,
    progressIntervalMs,
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
  if (listing.kind === "unsupported") {
    logger.warn(
      {
        event: "whisper.model.provisioning-unsupported",
        whisperModel: model,
        whisperBaseUrl: baseUrl,
        detail: listing.detail,
      },
      "the transcription backend has no model listing we recognize; assuming the model is served",
    );
    return { status: "unsupported", detail: listing.detail };
  }

  if (listing.ids.includes(model)) {
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

  const durationMs = now() - startedAt;
  await verifyInstalled(context, durationMs);

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
 * Reads the listing, retrying while the backend is unreachable or erroring.
 *
 * The retry is not politeness: the worker starts alongside the backend, so
 * "connection refused" on the first attempt is the normal case, not a fault.
 */
async function pollInstalledModels(
  context: ProvisioningContext,
): Promise<InstalledModels | UnsupportedBackend> {
  let announcedWait = false;
  for (;;) {
    const attempt = await readInstalledModels(context);
    if (attempt.kind !== "retry") return attempt;

    if (context.now() >= context.deadline) {
      throw new ModelProvisioningError(
        "backend-unreachable",
        context.model,
        `the transcription backend at ${context.baseUrl} did not answer a model listing in time: ${attempt.detail}`,
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
interface UnsupportedBackend {
  kind: "unsupported";
  detail: string;
}
interface RetryLater {
  kind: "retry";
  detail: string;
}

async function readInstalledModels(
  context: ProvisioningContext,
): Promise<InstalledModels | UnsupportedBackend | RetryLater> {
  let response: Response;
  try {
    response = await context.request("/models", "GET", context.probeTimeoutMs);
  } catch (error) {
    return { kind: "retry", detail: describe(error) };
  }

  // A backend that never implements the route says so immediately and will keep
  // saying it, so retrying is pointless — and blocking startup on a backend that
  // simply serves one baked-in model would be worse than starting.
  if (response.status === 404 || response.status === 405 || response.status === 501) {
    return { kind: "unsupported", detail: `GET /models answered ${response.status}` };
  }
  if (!response.ok) {
    return { kind: "retry", detail: `GET /models answered ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { kind: "unsupported", detail: "GET /models did not return JSON" };
  }
  const parsed = ModelListSchema.safeParse(body);
  if (!parsed.success) {
    return {
      kind: "unsupported",
      detail: "GET /models did not return an OpenAI-compatible model list",
    };
  }
  return { kind: "list", ids: parsed.data.data.map((entry) => entry.id) };
}

/**
 * Downloads the model, retrying transient failures until the deadline.
 *
 * A 404 is the case worth separating from all the others: the backend looked the
 * ID up and does not have it, which is a typo in `WHISPER_MODEL` rather than a
 * bad day on the network. Retrying it would turn a one-line fix into a slow,
 * silent startup, so it fails immediately and says how to find the right ID.
 */
async function installModel(context: ProvisioningContext): Promise<void> {
  const path = `/models/${modelPath(context.model)}`;
  for (;;) {
    const remaining = Math.max(context.deadline - context.now(), 1);
    let response: Response;
    try {
      response = await withProgressLogging(context, () => context.request(path, "POST", remaining));
    } catch (error) {
      await retryOrGiveUp(context, describe(error));
      continue;
    }

    if (response.ok) return;

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
 * Only a listing that comes back and does *not* contain the model is treated as
 * a failure. If the listing itself is unavailable at this point, the download's
 * own success is the better evidence, so that stays a warning: refusing to start
 * over a flaky second request would be a worse outcome than starting.
 */
async function verifyInstalled(context: ProvisioningContext, durationMs: number): Promise<void> {
  const listing = await readInstalledModels(context);
  if (listing.kind === "list" && !listing.ids.includes(context.model)) {
    throw new ModelProvisioningError(
      "not-installed",
      context.model,
      `the transcription backend reported "${context.model}" as downloaded but does not list it as installed`,
    );
  }
  if (listing.kind !== "list") {
    context.logger.warn(
      {
        event: "whisper.model.verify-skipped",
        whisperModel: context.model,
        whisperBaseUrl: context.baseUrl,
        detail: listing.detail,
        durationMs,
      },
      "could not re-read the model listing after the download; trusting the download's own result",
    );
  }
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
