import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorkerLogger } from "./logger.js";

/**
 * Why the worker is stopping.
 *
 * Exactly one of these is a request: `signal`. An operator, an orchestrator or
 * the end-to-end harness asked the process to stop, and stopping is then the
 * correct behavior. Every other member is the process deciding to stop by
 * itself, which is never correct for a queue consumer — jobs stay in the queue
 * and nothing consumes them.
 */
export type ShutdownTrigger =
  | { readonly kind: "signal"; readonly signal: string }
  | { readonly kind: "startup-failed"; readonly error: unknown }
  | { readonly kind: "uncaught-exception"; readonly error: unknown }
  | { readonly kind: "unhandled-rejection"; readonly error: unknown }
  | { readonly kind: "queue-stopped" }
  | { readonly kind: "event-loop-drained" };

/**
 * Status for a stop nobody asked for: sysexits(3) `EX_SOFTWARE`.
 *
 * A value from the sysexits range rather than a bare `1`, because `1` is what
 * every library, every unhandled throw and every failed assertion already
 * returns — a supervisor that sees `1` learns only "something went wrong",
 * while `70` says "this process decided to stop and that decision was a fault".
 * What matters most is that it is not 0: a supervisor reads 0 as "this process
 * was finished", and a queue consumer never is.
 */
export const UNREQUESTED_SHUTDOWN_EXIT_CODE = 70;

/**
 * Ceiling on a requested shutdown.
 *
 * It has to sit comfortably above the queue's own drain window — the caller's
 * `release` waits for in-flight jobs to finish — or the cap fires first on
 * every slow job and turns an ordinary restart into a reported fault. See
 * `QUEUE_DRAIN_TIMEOUT_MS` in `index.ts` for the other half of that pair.
 */
const DEFAULT_RELEASE_TIMEOUT_MS = 45_000;

/**
 * Ceiling after a fault. Short on purpose: nothing is waited for on this path,
 * so anything slow here is a socket that will not close, and a process that has
 * already lost its footing should not keep answering `/healthz` while it waits.
 */
const DEFAULT_FAULT_RELEASE_TIMEOUT_MS = 5_000;

/** One human-readable reason per trigger, used as the log message. */
const REASONS: Record<ShutdownTrigger["kind"], string> = {
  signal: "a stop was requested",
  "startup-failed": "startup failed before the worker was consuming jobs",
  "uncaught-exception": "an exception reached the top of the stack",
  "unhandled-rejection": "a promise rejected with nobody handling it",
  "queue-stopped": "the job queue stopped without being asked to",
  "event-loop-drained":
    "the event loop ran out of work, which a queue consumer can never legitimately do",
};

/** How the caller should give its resources back. */
export interface ReleaseOptions {
  /**
   * Whether in-flight work may finish first. False after a fault: the process
   * is no longer trustworthy, so waiting on it buys corrupted output at best,
   * and the jobs are safer back on the queue where another replica retries them.
   */
  readonly graceful: boolean;
}

export interface LifecycleOptions {
  logger: WorkerLogger;
  /**
   * Gives back everything the worker holds: the metrics port, the queue, the
   * database pool. Called at most once, and expected to tolerate being called
   * when startup only got halfway.
   */
  release: (options: ReleaseOptions) => Promise<void>;
  /** Terminates the process. Injected so the guard can be tested without one. */
  exit: (code: number) => void;
  /** Overrides {@link DEFAULT_RELEASE_TIMEOUT_MS}; tests use a short one. */
  releaseTimeoutMs?: number;
  /** Overrides {@link DEFAULT_FAULT_RELEASE_TIMEOUT_MS}; tests use a short one. */
  faultReleaseTimeoutMs?: number;
}

/**
 * The subset of `process` the guard listens on. Narrow on purpose: a test hands
 * in a plain `EventEmitter` and drives the same wiring the real process gets.
 */
export interface LifecycleEvents {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  once(event: string, listener: (...args: unknown[]) => void): unknown;
}

export interface WorkerLifecycle {
  /** Attaches the signal, drain and crash guards. Call before starting anything. */
  install(events: LifecycleEvents): void;
  /** Runs the shutdown for `trigger`. The first trigger wins; later ones are ignored. */
  shutdown(trigger: ShutdownTrigger): Promise<void>;
  /**
   * Fire-and-forget {@link shutdown} for callers that are event handlers and
   * have nowhere to await. Carries the last-resort exit, so no failure anywhere
   * in the shutdown can leave the process standing.
   */
  triggerShutdown(trigger: ShutdownTrigger): void;
}

/**
 * Makes the worker's two ways of stopping tell themselves apart from outside
 * the process.
 *
 * The worker is a queue consumer with a listening metrics socket, so under
 * normal operation its event loop never runs dry and it never returns from
 * `main`. It stops only when told to. That means every exit falls into one of
 * two classes, and before this guard existed both looked identical from the
 * outside: status 0, and — because the one line about it was logged at `info`,
 * below the threshold the end-to-end harness runs the worker at — no output at
 * all. A worker that quietly disappears is then indistinguishable from a worker
 * that finished its work, which is the failure mode this exists to remove.
 *
 * So: a requested stop drains gracefully, logs the signal at `warn` (a level
 * that survives every threshold we deploy with) and exits 0 — including when
 * the release itself fails, because a socket that will not close during a
 * `compose down` is not a reason to tell a supervisor the worker crashed.
 * Anything else stops the queue without waiting, logs the reason at `error` and
 * exits non-zero — including the case where nothing threw at all and the loop
 * merely drained, which is the only way a healthy-looking Node process can
 * vanish without a word.
 *
 * Nothing in here may throw its way out. The fault being reported is quite
 * possibly a broken logger, and a report that dies on the way out would restore
 * exactly the silent status 0 this guard exists to make impossible; so every
 * step is attempted rather than trusted, and the exit lives in a `finally`.
 */
export function createLifecycle(options: LifecycleOptions): WorkerLifecycle {
  const { logger, release, exit } = options;
  const releaseTimeoutMs = options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;
  const faultReleaseTimeoutMs = options.faultReleaseTimeoutMs ?? DEFAULT_FAULT_RELEASE_TIMEOUT_MS;
  let shuttingDown = false;

  /** Runs `step`, swallowing anything it throws. Reports whether it got through. */
  function attempt(step: () => void): boolean {
    try {
      step();
      return true;
    } catch {
      return false;
    }
  }

  async function shutdown(trigger: ShutdownTrigger): Promise<void> {
    if (shuttingDown) {
      reportIgnored(trigger);
      return;
    }
    shuttingDown = true;

    const requested = trigger.kind === "signal";
    let code = requested ? 0 : UNREQUESTED_SHUTDOWN_EXIT_CODE;

    try {
      // A logger that cannot write is itself a fault, and one that could hide
      // every other fault — so failing to announce changes the exit code.
      if (!attempt(() => announce(trigger, requested))) {
        code = UNREQUESTED_SHUTDOWN_EXIT_CODE;
      }

      try {
        await withTimeout(
          release({ graceful: requested }),
          requested ? releaseTimeoutMs : faultReleaseTimeoutMs,
        );
      } catch (error: unknown) {
        reportReleaseFailure(error, requested);
        // Only an unrequested stop escalates. During a `compose down` the
        // database and the worker get their signal at the same moment, so the
        // pool close losing its connection is the ordinary shape of a correct
        // teardown; turning that into a non-zero exit would make every restart
        // an intermittent failure and every operator ignore the code.
        if (!requested) code = UNREQUESTED_SHUTDOWN_EXIT_CODE;
      }
    } finally {
      exit(code);
    }
  }

  function announce(trigger: ShutdownTrigger, requested: boolean): void {
    if (requested && trigger.kind === "signal") {
      logger.warn(
        { event: "worker.stopping", reason: trigger.kind, signal: trigger.signal },
        REASONS[trigger.kind],
      );
      return;
    }
    logger.error(
      { event: "worker.stopping", reason: trigger.kind, ...errorField(trigger) },
      REASONS[trigger.kind],
    );
  }

  function reportReleaseFailure(error: unknown, requested: boolean): void {
    const fields = { event: "worker.shutdown-failed", err: error };
    const message = "releasing the worker's resources did not finish";
    attempt(() =>
      requested
        ? logger.warn(fields, `${message}; the requested stop still counts as clean`)
        : logger.error(fields, `${message}; exiting anyway`),
    );
  }

  /**
   * A trigger that arrived while a shutdown was already running.
   *
   * Level by content, not by kind. A teardown in progress produces expected
   * followers — pg-boss emits `stopped` because the release just stopped it,
   * and the loop drains once the last handle is gone — and logging those at
   * `error` would put a false alarm in every clean shutdown. A trigger carrying
   * an error is different: that is a crash being dropped on the floor, and the
   * stack is the only record of it there will ever be.
   */
  function reportIgnored(trigger: ShutdownTrigger): void {
    const fields = {
      event: "worker.shutdown-trigger-ignored",
      reason: trigger.kind,
      ...errorField(trigger),
    };
    const message = "a shutdown was already running; this trigger was ignored";
    attempt(() =>
      "error" in trigger ? logger.error(fields, message) : logger.debug(fields, message),
    );
  }

  function triggerShutdown(trigger: ShutdownTrigger): void {
    // The last resort. `shutdown` is written not to reject, but this is the
    // guard against silent exits — it does not get to assume its own
    // correctness, because the cost of being wrong is the bug it was built for.
    void shutdown(trigger).catch(() => attempt(() => exit(UNREQUESTED_SHUTDOWN_EXIT_CODE)));
  }

  return {
    install(events: LifecycleEvents): void {
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        events.once(signal, () => triggerShutdown({ kind: "signal", signal }));
      }
      // The decisive one. `beforeExit` fires when the loop has nothing left to
      // do — the state a queue consumer cannot reach — and Node would otherwise
      // exit 0 from here without a word.
      events.on("beforeExit", () => triggerShutdown({ kind: "event-loop-drained" }));
      events.on("uncaughtException", (error: unknown) =>
        triggerShutdown({ kind: "uncaught-exception", error }),
      );
      events.on("unhandledRejection", (error: unknown) =>
        triggerShutdown({ kind: "unhandled-rejection", error }),
      );
    },
    shutdown,
    triggerShutdown,
  };
}

/** `err` for the triggers that carry one, nothing for the ones that do not. */
function errorField(trigger: ShutdownTrigger): { err?: unknown } {
  return "error" in trigger ? { err: trigger.error } : {};
}

async function withTimeout(work: Promise<void>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`the shutdown did not finish within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  try {
    await Promise.race([work, expiry]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Whether this module was started as the program, rather than imported.
 *
 * The obvious spelling — comparing `import.meta.url` against
 * `` `file://${process.argv[1]}` `` — is wrong for every path that a URL has to
 * escape (a space, a `#`, anything non-ASCII) and for a symlinked entry point,
 * because `import.meta.url` is the resolved real path while `process.argv[1]`
 * is whatever the command line said. A mismatch is silent and total: `main`
 * never runs, nothing is logged, and the process exits 0 having done nothing.
 * Comparing paths rather than spellings is what makes that impossible.
 */
export function isEntrypoint(moduleUrl: string, entryArgument: string | undefined): boolean {
  if (entryArgument === undefined || entryArgument === "") return false;
  try {
    const modulePath = fileURLToPath(moduleUrl);
    const entryPath = resolve(entryArgument);
    if (modulePath === entryPath) return true;
    return realpathSync(modulePath) === realpathSync(entryPath);
  } catch {
    // Either the module URL is not a file at all — a bundler or a custom loader
    // scheme — or one of the two paths is not on disk. Neither is this program.
    return false;
  }
}
