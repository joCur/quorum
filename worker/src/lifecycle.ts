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
 * Status for a stop nobody asked for.
 *
 * Any non-zero value would do; what matters is that it is not 0, because a
 * supervisor — Docker's restart policy, the end-to-end harness, a future
 * systemd unit — reads 0 as "this process was finished" and a queue consumer is
 * never finished.
 */
export const UNREQUESTED_SHUTDOWN_EXIT_CODE = 70;

/** How long the release may take before the process gives up and exits anyway. */
const DEFAULT_RELEASE_TIMEOUT_MS = 30_000;

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

export interface LifecycleOptions {
  logger: WorkerLogger;
  /**
   * Gives back everything the worker holds: the metrics port, the queue, the
   * database pool. Called at most once, and expected to tolerate being called
   * when startup only got halfway.
   */
  release: () => Promise<void>;
  /** Terminates the process. Injected so the guard can be tested without one. */
  exit: (code: number) => void;
  /** Overrides {@link DEFAULT_RELEASE_TIMEOUT_MS}; tests use a short one. */
  releaseTimeoutMs?: number;
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
}

/**
 * Makes the worker's two ways of stopping tell themselves apart from outside
 * the process.
 *
 * The worker is a queue consumer with a listening metrics socket, so under
 * normal operation its event loop never runs dry and it never returns from
 * `main`. It stops only when told to. That means every exit falls into one of
 * two classes, and before this guard existed both looked identical from the
 * outside: status 0, and — because the one line about it was logged at `info`
 * while the harness and the container both run at `warn` — no output at all. A
 * worker that quietly disappears is then indistinguishable from a worker that
 * finished its work, which is the failure mode this exists to remove.
 *
 * So: a requested stop logs the signal at `warn` (a level that survives every
 * threshold we deploy with) and exits 0. Anything else logs the reason at
 * `error` and exits non-zero — including the case where nothing threw at all
 * and the loop merely drained, which is the only way a healthy-looking Node
 * process can vanish without a word.
 */
export function createLifecycle(options: LifecycleOptions): WorkerLifecycle {
  const { logger, release, exit } = options;
  const releaseTimeoutMs = options.releaseTimeoutMs ?? DEFAULT_RELEASE_TIMEOUT_MS;
  let shuttingDown = false;

  async function shutdown(trigger: ShutdownTrigger): Promise<void> {
    // A signal on the heels of a crash, or pg-boss emitting `stopped` because
    // the release just stopped it, must not start a second teardown.
    if (shuttingDown) return;
    shuttingDown = true;

    const requested = trigger.kind === "signal";
    let code = requested ? 0 : UNREQUESTED_SHUTDOWN_EXIT_CODE;

    if (requested) {
      logger.warn(
        { event: "worker.stopping", reason: trigger.kind, signal: trigger.signal },
        REASONS[trigger.kind],
      );
    } else {
      logger.error(
        { event: "worker.stopping", reason: trigger.kind, ...errorField(trigger) },
        REASONS[trigger.kind],
      );
    }

    try {
      await withTimeout(release(), releaseTimeoutMs);
    } catch (error: unknown) {
      // A teardown that hangs or throws must still end in an exit, and it is
      // never a clean one: something the worker held was not given back.
      logger.error(
        { event: "worker.shutdown-failed", err: error },
        "releasing the worker's resources failed; exiting anyway",
      );
      code = UNREQUESTED_SHUTDOWN_EXIT_CODE;
    }

    exit(code);
  }

  return {
    install(events: LifecycleEvents): void {
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        events.once(signal, () => void shutdown({ kind: "signal", signal }));
      }
      // The decisive one. `beforeExit` fires when the loop has nothing left to
      // do — the state a queue consumer cannot reach — and Node would otherwise
      // exit 0 from here without a word.
      events.on("beforeExit", () => void shutdown({ kind: "event-loop-drained" }));
      events.on(
        "uncaughtException",
        (error: unknown) => void shutdown({ kind: "uncaught-exception", error }),
      );
      events.on(
        "unhandledRejection",
        (error: unknown) => void shutdown({ kind: "unhandled-rejection", error }),
      );
    },
    shutdown,
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
  const modulePath = fileURLToPath(moduleUrl);
  const entryPath = resolve(entryArgument);
  if (modulePath === entryPath) return true;
  try {
    return realpathSync(modulePath) === realpathSync(entryPath);
  } catch {
    // One of the two does not exist on disk; then they are not the same file.
    return false;
  }
}
