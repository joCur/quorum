import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  createLifecycle,
  isEntrypoint,
  UNREQUESTED_SHUTDOWN_EXIT_CODE,
  type LifecycleEvents,
  type ReleaseOptions,
  type WorkerLifecycle,
} from "../src/lifecycle.js";
import type { WorkerLogger } from "../src/logger.js";

type Level = "debug" | "warn" | "error";
interface Line {
  level: Level;
  fields: Record<string, unknown>;
  message: string;
}

/** Records what was logged at which level, which is most of the contract here. */
function recordingLogger(throws = false): { logger: WorkerLogger; lines: Line[] } {
  const lines: Line[] = [];
  const at =
    (level: Level) =>
    (fields: Record<string, unknown>, message: string): void => {
      if (throws) throw new Error("the log transport is gone");
      lines.push({ level, fields, message });
    };
  return {
    logger: {
      debug: at("debug"),
      warn: at("warn"),
      error: at("error"),
    } as unknown as WorkerLogger,
    lines,
  };
}

interface Overrides {
  release?: (options: ReleaseOptions) => Promise<void>;
  releaseTimeoutMs?: number;
  faultReleaseTimeoutMs?: number;
  loggerThrows?: boolean;
}

function subject(overrides: Overrides = {}): {
  lifecycle: WorkerLifecycle;
  events: LifecycleEvents & EventEmitter;
  exit: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
  lines: Line[];
} {
  const { logger, lines } = recordingLogger(overrides.loggerThrows ?? false);
  const exit = vi.fn();
  const release = vi.fn(overrides.release ?? (async () => {}));
  const lifecycle = createLifecycle({
    logger,
    release,
    exit,
    ...(overrides.releaseTimeoutMs === undefined
      ? {}
      : { releaseTimeoutMs: overrides.releaseTimeoutMs }),
    ...(overrides.faultReleaseTimeoutMs === undefined
      ? {}
      : { faultReleaseTimeoutMs: overrides.faultReleaseTimeoutMs }),
  });
  const events = new EventEmitter();
  lifecycle.install(events);
  return { lifecycle, events, exit, release, lines };
}

/** Lets the handler an `emit` kicked off run to completion, timers included. */
async function settle(): Promise<void> {
  await new Promise((done) => setImmediate(done));
  await new Promise((done) => setTimeout(done, 50));
  await new Promise((done) => setImmediate(done));
}

function stopping(lines: Line[]): Line | undefined {
  return lines.find((line) => line.fields["event"] === "worker.stopping");
}

describe("worker shutdown guard", () => {
  it("exits non-zero and says why when the event loop drains on its own", async () => {
    // The regression: a queue consumer whose loop runs dry has stopped doing its
    // job, and Node's own answer to that is a wordless status 0.
    const { events, exit, lines } = subject();

    events.emit("beforeExit", 0);
    await settle();

    expect(exit).toHaveBeenCalledWith(UNREQUESTED_SHUTDOWN_EXIT_CODE);
    expect(UNREQUESTED_SHUTDOWN_EXIT_CODE).not.toBe(0);
    expect(stopping(lines)?.level).toBe("error");
    expect(stopping(lines)?.fields["reason"]).toBe("event-loop-drained");
    expect(stopping(lines)?.message).toMatch(/event loop/);
  });

  it("exits non-zero when the job queue stops without being asked", async () => {
    const { lifecycle, exit, lines } = subject();

    await lifecycle.shutdown({ kind: "queue-stopped" });

    expect(exit).toHaveBeenCalledWith(UNREQUESTED_SHUTDOWN_EXIT_CODE);
    expect(stopping(lines)?.level).toBe("error");
  });

  it("reports a failed startup at error level instead of lingering", async () => {
    const { lifecycle, exit, release, lines } = subject();

    await lifecycle.shutdown({ kind: "startup-failed", error: new Error("no database") });

    // Whatever startup already took hold of is given back — otherwise the port
    // stays bound by a process that consumes nothing.
    expect(release).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(UNREQUESTED_SHUTDOWN_EXIT_CODE);
    expect(stopping(lines)?.level).toBe("error");
    expect((stopping(lines)?.fields["err"] as Error).message).toBe("no database");
  });

  it("exits cleanly on a signal, and says so at a level the deployed threshold shows", async () => {
    // `warn`: the worker runs at `warn` in the end-to-end harness, so an `info`
    // line about stopping is a line nobody there ever sees.
    const { events, exit, release, lines } = subject();

    events.emit("SIGTERM", "SIGTERM");
    await settle();

    expect(release).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
    expect(stopping(lines)?.level).toBe("warn");
    expect(stopping(lines)?.fields["signal"]).toBe("SIGTERM");
  });

  it("tears down once no matter how many triggers arrive", async () => {
    const { lifecycle, events, exit, release } = subject();

    events.emit("SIGTERM", "SIGTERM");
    events.emit("SIGINT", "SIGINT");
    await lifecycle.shutdown({ kind: "queue-stopped" });
    await settle();

    expect(release).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("reports an exception that reached the top of the stack", async () => {
    const { events, exit, lines } = subject();

    events.emit("uncaughtException", new Error("boom"));
    await settle();

    expect(exit).toHaveBeenCalledWith(UNREQUESTED_SHUTDOWN_EXIT_CODE);
    expect(lines.find((line) => line.fields["reason"] === "uncaught-exception")).toBeDefined();
  });

  it("reports a rejection nobody handled", async () => {
    const { events, exit, lines } = subject();

    events.emit("unhandledRejection", new Error("boom"));
    await settle();

    expect(exit).toHaveBeenCalledWith(UNREQUESTED_SHUTDOWN_EXIT_CODE);
    expect(lines.find((line) => line.fields["reason"] === "unhandled-rejection")).toBeDefined();
  });
});

describe("a requested stop stays clean", () => {
  it("exits 0 when draining the queue takes a while", async () => {
    // The regression: the ceiling used to fire before a slow drain finished, so
    // an ordinary redeploy during a long transcription was reported as a fault.
    // The ceiling has to sit above the queue's own drain window, not under it.
    const { lifecycle, exit, lines } = subject({
      release: () => new Promise((done) => setTimeout(done, 40)),
      releaseTimeoutMs: 5_000,
    });

    await lifecycle.shutdown({ kind: "signal", signal: "SIGTERM" });

    expect(exit).toHaveBeenCalledWith(0);
    expect(lines.find((line) => line.fields["event"] === "worker.shutdown-failed")).toBeUndefined();
  });

  it("exits 0 when the release fails because the database went away with it", async () => {
    // The regression: `compose down` signals postgres and the worker at the same
    // moment, so the pool close losing its connection is the ordinary shape of a
    // correct teardown. Escalating it made every restart an intermittent failure.
    const { lifecycle, exit, lines } = subject({
      release: () => Promise.reject(new Error("ECONNREFUSED")),
    });

    await lifecycle.shutdown({ kind: "signal", signal: "SIGTERM" });

    expect(exit).toHaveBeenCalledWith(0);
    const failure = lines.find((line) => line.fields["event"] === "worker.shutdown-failed");
    expect(failure?.level).toBe("warn");
  });

  it("still exits, and cleanly, when the release never returns", async () => {
    // A ceiling that fires is reported, but the stop was still the one that was
    // asked for: the supervisor is told the truth by the log line, not by a
    // status that would make it restart a container somebody deliberately shut down.
    const { lifecycle, exit, lines } = subject({
      release: () => new Promise<void>(() => {}),
      releaseTimeoutMs: 10,
    });

    await lifecycle.shutdown({ kind: "signal", signal: "SIGTERM" });

    expect(exit).toHaveBeenCalledWith(0);
    expect(lines.find((line) => line.fields["event"] === "worker.shutdown-failed")?.level).toBe(
      "warn",
    );
  });

  it("caps a fault's release far shorter, and exits non-zero", async () => {
    const { events, exit, lines } = subject({
      release: () => new Promise<void>(() => {}),
      faultReleaseTimeoutMs: 10,
    });

    events.emit("uncaughtException", new Error("boom"));
    await settle();

    expect(exit).toHaveBeenCalledWith(UNREQUESTED_SHUTDOWN_EXIT_CODE);
    expect(lines.find((line) => line.fields["event"] === "worker.shutdown-failed")?.level).toBe(
      "error",
    );
  });
});

describe("a fault does not wait", () => {
  it("stops the queue without draining it", async () => {
    // Waiting up to the full window for in-flight jobs inside a process that has
    // already lost its footing buys nothing: the jobs are safer back on the queue.
    const { events, release } = subject();

    events.emit("uncaughtException", new Error("boom"));
    await settle();

    expect(release).toHaveBeenCalledWith({ graceful: false });
  });

  it("drains gracefully only when the stop was requested", async () => {
    const { events, release } = subject();

    events.emit("SIGTERM", "SIGTERM");
    await settle();

    expect(release).toHaveBeenCalledWith({ graceful: true });
  });
});

describe("nothing can restore the silent exit", () => {
  it("exits non-zero even when the logger itself throws", async () => {
    // The regression: the announcement sat outside the try, so a broken log
    // transport — plausibly the very fault being reported — made `shutdown`
    // reject before it could exit. The loop then drained and Node exited 0.
    const { lifecycle, exit } = subject({ loggerThrows: true });

    await lifecycle.shutdown({ kind: "signal", signal: "SIGTERM" });

    expect(exit).toHaveBeenCalledWith(UNREQUESTED_SHUTDOWN_EXIT_CODE);
  });

  it("exits even when the logger throws on the way out of a crash", async () => {
    const { events, exit } = subject({ loggerThrows: true });

    events.emit("uncaughtException", new Error("boom"));
    await settle();

    expect(exit).toHaveBeenCalledWith(UNREQUESTED_SHUTDOWN_EXIT_CODE);
  });

  it("releases what it holds even when it cannot say why it is stopping", async () => {
    const { lifecycle, release } = subject({ loggerThrows: true });

    await lifecycle.shutdown({ kind: "signal", signal: "SIGTERM" });

    expect(release).toHaveBeenCalledOnce();
  });
});

describe("a trigger that arrives too late", () => {
  it("logs the crash it is dropping on the floor", async () => {
    // Otherwise an exception raised while a stop is already running leaves no
    // record anywhere: the latch returns and the stack is gone for good.
    const { events, lines } = subject({
      release: () => new Promise((done) => setTimeout(done, 20)),
    });

    events.emit("SIGTERM", "SIGTERM");
    events.emit("uncaughtException", new Error("during the drain"));
    await settle();

    const ignored = lines.find(
      (line) => line.fields["event"] === "worker.shutdown-trigger-ignored",
    );
    expect(ignored?.level).toBe("error");
    expect(ignored?.fields["reason"]).toBe("uncaught-exception");
    expect((ignored?.fields["err"] as Error).message).toBe("during the drain");
  });

  it("keeps the expected followers of a clean stop out of the error log", async () => {
    // The queue emits `stopped` because the release just stopped it, and the
    // loop drains once the last handle is gone. Both are the shutdown working.
    const { lifecycle, events, lines } = subject({
      release: () => new Promise((done) => setTimeout(done, 20)),
    });

    events.emit("SIGTERM", "SIGTERM");
    await lifecycle.shutdown({ kind: "queue-stopped" });
    events.emit("beforeExit", 0);
    await settle();

    const ignored = lines.filter(
      (line) => line.fields["event"] === "worker.shutdown-trigger-ignored",
    );
    expect(ignored).toHaveLength(2);
    expect(ignored.every((line) => line.level === "debug")).toBe(true);
    expect(lines.filter((line) => line.level === "error")).toEqual([]);
  });
});

describe("entrypoint detection", () => {
  const directory = mkdtempSync(join(tmpdir(), "quorum-entrypoint-"));

  function file(name: string): string {
    const path = join(directory, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "");
    return path;
  }

  it("recognizes the plain case", () => {
    const path = file("index.js");
    expect(isEntrypoint(pathToFileURL(path).href, path)).toBe(true);
  });

  it("recognizes a path a URL has to escape", () => {
    // The regression: `file://${process.argv[1]}` is not a URL, so one space in
    // the checkout path made the entry check fail, `main` never ran, and the
    // process exited 0 without a word.
    const path = file("a folder/index.js");
    expect(isEntrypoint(pathToFileURL(path).href, path)).toBe(true);
  });

  it("recognizes a relative entry argument", () => {
    const path = file("relative.js");
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(directory);
    try {
      expect(isEntrypoint(pathToFileURL(path).href, "./relative.js")).toBe(true);
    } finally {
      cwd.mockRestore();
    }
  });

  it("recognizes a symlinked entry point", () => {
    // Node resolves `import.meta.url` through the symlink but leaves
    // `process.argv[1]` as typed, so the two spellings never match.
    const path = file("real.js");
    const link = join(directory, "link.js");
    symlinkSync(path, link);
    expect(isEntrypoint(pathToFileURL(path).href, link)).toBe(true);
  });

  it("says no, rather than throwing, for a module URL that is not a file", () => {
    // A bundler or a custom loader can hand out any scheme it likes, and
    // `fileURLToPath` answers those with a throw.
    expect(isEntrypoint("data:text/javascript,0", file("entry.js"))).toBe(false);
    expect(isEntrypoint("https://example.invalid/index.js", file("other-entry.js"))).toBe(false);
  });

  it("says no when the module was merely imported", () => {
    expect(isEntrypoint(pathToFileURL(file("library.js")).href, file("other.js"))).toBe(false);
    expect(isEntrypoint(pathToFileURL(file("solo.js")).href, undefined)).toBe(false);
    expect(isEntrypoint(pathToFileURL(file("empty.js")).href, "")).toBe(false);
  });
});
