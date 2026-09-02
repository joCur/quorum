/**
 * Noticing that the deployment has moved on.
 *
 * The browser only re-fetches the service worker of its own accord on a navigation, which an
 * installed PWA that is never closed may not perform for days. So the app asks: on an interval
 * while it is open, whenever it comes back to the foreground, and whenever the network returns.
 *
 * Two independent signals say "there is a newer version", because neither covers the whole field:
 *
 *  - The service worker took control (`controllerchange`). The worker is generated with
 *    `skipWaiting`, so a newer one installs and activates without asking the running page for
 *    permission — which is exactly what lets a shell that predates this code recover.
 *  - The deployed version marker no longer matches the version this bundle was built from. This
 *    is the one that still works where service workers do not (a private window, a browser with
 *    them switched off), and it is what turns "the worker swapped underneath us" into a statement
 *    about the *app* the user is looking at.
 */

/** Where the built app publishes the version it was cut from. Never precached. */
export const VERSION_MANIFEST_URL = "/version.json";

/** How often an open tab asks, absent any other trigger. */
export const DEFAULT_CHECK_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Floor between two checks, so that flicking between tabs cannot turn a foreground trigger into
 * a request loop.
 */
export const DEFAULT_MIN_CHECK_SPACING_MS = 60 * 1000;

/** How long a check waits for a downloading worker to finish before giving up on it. */
export const ACTIVATION_TIMEOUT_MS = 30 * 1000;

/** Worker states that are not going to change on their own. */
const AT_REST = new Set<ServiceWorkerState>(["installed", "activated", "redundant"]);

export interface UpdateWatchDeps {
  /** `navigator.serviceWorker`, or `null` in a browser without one. */
  container: ServiceWorkerContainer | null;
  /** The version this bundle was built from. */
  runningVersion: string;
  /** Reads the deployed version, or resolves `null` when it cannot be read. */
  readDeployedVersion: () => Promise<string | null>;
  /** Called once, the first time a newer version is established. */
  onUpdateReady: () => void;
  checkIntervalMs?: number;
  minCheckSpacingMs?: number;
}

export interface UpdateWatch {
  /** Runs a check now, ignoring the spacing floor. Resolves when both signals have been read. */
  check(): Promise<void>;
  /** Detaches every listener and timer. */
  stop(): void;
}

/**
 * Starts watching for a newer deployment. Returns immediately; the first check is scheduled, not
 * awaited, so a slow or unreachable network never delays startup.
 */
export function startUpdateWatch(deps: UpdateWatchDeps): UpdateWatch {
  const intervalMs = deps.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS;
  const spacingMs = deps.minCheckSpacingMs ?? DEFAULT_MIN_CHECK_SPACING_MS;

  let stopped = false;
  let announced = false;
  let lastCheckAt = Number.NEGATIVE_INFINITY;

  const announce = () => {
    if (announced || stopped) return;
    announced = true;
    deps.onUpdateReady();
  };

  /**
   * The check in flight, if any.
   *
   * Overlapping checks are not merely wasteful: two `registration.update()` calls racing each
   * other can leave the browser holding a second installed worker parked in `waiting`, and a
   * registration in that state stalls the next navigation — the app becomes unreachable rather
   * than merely stale. The triggers here (startup, interval, foreground, reconnect) can easily
   * coincide, so one check runs at a time and the others join it.
   */
  let inFlight: Promise<void> | null = null;

  const check = (): Promise<void> => {
    inFlight ??= runCheck().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };

  const runCheck = async (): Promise<void> => {
    if (stopped) return;
    lastCheckAt = Date.now();
    // Sequential, not parallel, and this order specifically. The version marker is the faster of
    // the two answers, so racing them would raise the banner while the new worker is still
    // downloading — and a reload taken at that moment lands right back on the old shell, which
    // to the user is a button that does nothing. Letting the worker settle first makes the
    // banner mean what it says: the new version is ready, reloading will land on it.
    await refreshWorker();
    await compareVersions();
  };

  const refreshWorker = async (): Promise<void> => {
    const registration = await deps.container?.getRegistration();
    if (!registration || stopped) return;
    // A worker already parked in `waiting` is a version this page never picked up — the exact
    // state the production incident got stuck in. Report it even if `update()` finds nothing new.
    if (registration.waiting) announce();
    // Network failures here are ordinary (offline, a restarting edge) and say nothing about
    // whether an update exists, so they are swallowed rather than surfaced.
    await registration.update().catch(() => undefined);
    if (stopped) return;
    await settled(registration.installing);
    if (registration.waiting) announce();
  };

  /**
   * Waits for a worker that is still downloading to stop moving.
   *
   * `installed` counts as a resting state alongside `activated` and `redundant`. The generated
   * worker calls `skipWaiting` and should run straight through to `activated`, but a worker that
   * parks in `waiting` is a real state this code has to survive rather than hang on — it is the
   * state the incident was stuck in, and it is still worth announcing.
   */
  const settled = (worker: ServiceWorker | null): Promise<void> =>
    worker && !AT_REST.has(worker.state)
      ? new Promise((resolve) => {
          const done = () => {
            if (!AT_REST.has(worker.state)) return;
            worker.removeEventListener("statechange", done);
            window.clearTimeout(timeout);
            resolve();
          };
          const timeout = window.setTimeout(() => {
            worker.removeEventListener("statechange", done);
            resolve();
          }, ACTIVATION_TIMEOUT_MS);
          worker.addEventListener("statechange", done);
        })
      : Promise.resolve();

  const compareVersions = async (): Promise<void> => {
    const deployed = await deps.readDeployedVersion().catch(() => null);
    if (stopped || deployed === null) return;
    if (deployed !== deps.runningVersion) announce();
  };

  const checkIfDue = () => {
    if (Date.now() - lastCheckAt < spacingMs) return;
    void check();
  };

  /**
   * A page that loaded before any worker controlled it gets a `controllerchange` as soon as the
   * very first worker claims it. That is an install, not an update, and reporting it would greet
   * every first-time visitor with "a new version is available". Only a page that already had a
   * controller can have had it replaced.
   */
  const hadController = Boolean(deps.container?.controller);
  const onControllerChange = () => {
    if (hadController) announce();
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") checkIfDue();
  };

  deps.container?.addEventListener("controllerchange", onControllerChange);
  document.addEventListener("visibilitychange", onVisibilityChange);
  window.addEventListener("online", checkIfDue);
  const timer = window.setInterval(checkIfDue, intervalMs);

  void check();

  return {
    check,
    stop() {
      stopped = true;
      window.clearInterval(timer);
      deps.container?.removeEventListener("controllerchange", onControllerChange);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("online", checkIfDue);
    },
  };
}

/** Reads the deployed version marker, bypassing every cache between here and the origin. */
export async function readDeployedVersion(fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const response = await fetchImpl(VERSION_MANIFEST_URL, { cache: "no-store" });
  if (!response.ok) return null;
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) return null;
  const version = (body as { version?: unknown }).version;
  return typeof version === "string" ? version : null;
}
