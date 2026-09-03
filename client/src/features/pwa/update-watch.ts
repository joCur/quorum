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

/**
 * How long a worker that has reached `installed` is given to take over by itself.
 *
 * A worker that calls `skipWaiting` activates within a few hundred milliseconds of installing.
 * Waiting past that is only useful for deciding that it is not going to.
 */
export const ACTIVATION_GRACE_MS = 5 * 1000;

/**
 * Worker states that are not going to change on their own.
 *
 * `installed` is deliberately absent. A worker sits there for the moment between finishing its
 * install and taking over, and treating that moment as an answer is what made this check race the
 * browser: the very next thing the check does is fetch the version marker, and a request from a
 * controlled page in that window restarts the worker being replaced and leaves the new one parked
 * in `waiting` for good. See `settled`.
 */
const AT_REST = new Set<ServiceWorkerState>(["activated", "redundant"]);

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
   * Overlapping checks are not merely wasteful: a second check would issue its own requests while
   * the first is holding still for a worker that is taking over, which is the one window in which
   * a request from this page costs the handover (see `settled`). The triggers here (startup,
   * interval, foreground, reconnect) can easily coincide, so one check runs at a time and the
   * others join it.
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
    const parkedBefore = registration.waiting;
    if (parkedBefore) announce();
    // Network failures here are ordinary (offline, a restarting edge) and say nothing about
    // whether an update exists, so they are swallowed rather than surfaced.
    await registration.update().catch(() => undefined);
    if (stopped) return;
    // Whatever worker this check brought in: `update()` can resolve either side of the install
    // finishing, so it may already have moved out of `installing`. A worker that was parked
    // before this check began is not going anywhere and is not worth waiting for.
    const incoming =
      registration.installing ??
      (registration.waiting === parkedBefore ? null : registration.waiting);
    await settled(incoming);
    if (registration.waiting) announce();
  };

  /**
   * Waits for an incoming worker to stop moving — to have taken over, or to have visibly declined
   * to.
   *
   * The generated worker calls `skipWaiting`, so the honest resting states are `activated` and
   * `redundant`. Returning at `installed` instead would hand control back during the fraction of
   * a second in which the browser is activating the new worker, and the caller's next act is a
   * request for the version marker: that request is dispatched to the worker on its way out,
   * restarts it, and the browser abandons the activation, leaving the new worker in `waiting`
   * where nothing but closing every tab will release it.
   *
   * A worker that parks anyway — the shells that predate `skipWaiting` — must still not hang the
   * check, so `installed` starts a short grace period rather than a wait for the full timeout.
   */
  const settled = (worker: ServiceWorker | null): Promise<void> => {
    if (!worker || AT_REST.has(worker.state)) return Promise.resolve();
    return new Promise((resolve) => {
      let grace: number | undefined;
      const finish = () => {
        worker.removeEventListener("statechange", onChange);
        window.clearTimeout(timeout);
        if (grace !== undefined) window.clearTimeout(grace);
        resolve();
      };
      const onChange = () => {
        if (AT_REST.has(worker.state)) return finish();
        if (worker.state === "installed" && grace === undefined)
          grace = window.setTimeout(finish, ACTIVATION_GRACE_MS);
      };
      const timeout = window.setTimeout(finish, ACTIVATION_TIMEOUT_MS);
      worker.addEventListener("statechange", onChange);
      onChange();
    });
  };

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

/**
 * How long the reload below waits before deciding the navigation is never going to arrive.
 *
 * Long enough that a slow but real navigation is not interrupted, short enough that nobody sits
 * looking at a page that has already stopped being one.
 */
export const RELOAD_RETRY_MS = 4 * 1000;

/**
 * Reloads onto the shell the service worker is about to serve.
 *
 * Not merely `location.reload()`, because of what a reload does to a worker parked in `waiting`:
 * tearing this page down removes the last client the outgoing worker controls, so the browser
 * releases the parked worker in the middle of the navigation it has just been handed. The request
 * belongs to a worker that is being discarded, no answer ever comes, and the tab is left on a
 * blank navigation with nothing reaching the network — worse than the stale page it replaced.
 *
 * The document survives its own pending navigation, so it can still notice. A second reload is
 * answered by the worker that has taken over in the meantime.
 */
export async function applyUpdate(
  container: ServiceWorkerContainer | null,
  reload: () => void,
): Promise<void> {
  const registration = await container?.getRegistration().catch(() => undefined);
  if (registration?.waiting) window.setTimeout(reload, RELOAD_RETRY_MS);
  reload();
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
