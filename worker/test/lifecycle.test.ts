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
  type WorkerLifecycle,
} from "../src/lifecycle.js";
import type { WorkerLogger } from "../src/logger.js";

/** Records what was logged at which level, which is the whole contract here. */
function recordingLogger(): {
  logger: WorkerLogger;
  lines: Array<{ level: "warn" | "error"; fields: Record<string, unknown>; message: string }>;
} {
  const lines: Array<{
    level: "warn" | "error";
    fields: Record<string, unknown>;
    message: string;
  }> = [];
  const at =
    (level: "warn" | "error") =>
    (fields: Record<string, unknown>, message: string): void => {
      lines.push({ level, fields, message });
    };
  return { logger: { warn: at("warn"), error: at("error") } as unknown as WorkerLogger, lines };
}

function subject(overrides: { release?: () => Promise<void>; releaseTimeoutMs?: number } = {}): {
  lifecycle: WorkerLifecycle;
  events: LifecycleEvents & EventEmitter;
  exit: ReturnType<typeof vi.fn>;
  release: () => Promise<void>;
  lines: ReturnType<typeof recordingLogger>["lines"];
} {
  const { logger, lines } = recordingLogger();
  const exit = vi.fn();
  const release = overrides.release ?? vi.fn(async () => {});
  const lifecycle = createLifecycle({
    logger,
    release,
    exit,
    ...(overrides.releaseTimeoutMs === undefined
      ? {}
      : { releaseTimeoutMs: overrides.releaseTimeoutMs }),
  });
  const events = new EventEmitter();
  lifecycle.install(events);
  return { lifecycle, events, exit, release, lines };
}

/** Lets the handler an `emit` kicked off run to completion. */
async function settle(): Promise<void> {
  await new Promise((done) => setImmediate(done));
  await new Promise((done) => setImmediate(done));
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
    const reported = lines.find((line) => line.fields["event"] === "worker.stopping");
    expect(reported?.level).toBe("error");
    expect(reported?.fields["reason"]).toBe("event-loop-drained");
    expect(reported?.message).toMatch(/event loop/);
  });

  it("exits non-zero when the job queue stops without being asked", async () => {
    const { lifecycle, exit, lines } = subject();

    await lifecycle.shutdown({ kind: "queue-stopped" });

    expect(exit).toHaveBeenCalledWith(UNREQUESTED_SHUTDOWN_EXIT_CODE);
    expect(lines.find((line) => line.fields["event"] === "worker.stopping")?.level).toBe("error");
  });

  it("reports a failed startup at error level instead of lingering", async () => {
    const { lifecycle, exit, release, lines } = subject();

    await lifecycle.shutdown({ kind: "startup-failed", error: new Error("no database") });

    // Whatever startup already took hold of is given back — otherwise the port
    // stays bound by a process that consumes nothing.
    expect(release).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(UNREQUESTED_SHUTDOWN_EXIT_CODE);
    const reported = lines.find((line) => line.fields["event"] === "worker.stopping");
    expect(reported?.level).toBe("error");
    expect((reported?.fields["err"] as Error).message).toBe("no database");
  });

  it("exits cleanly on a signal, and says so at a level the deployed threshold shows", async () => {
    // `warn`: the worker runs at `warn` in the end-to-end harness and in the
    // container, so an `info` line about stopping is a line nobody ever sees.
    const { events, exit, release, lines } = subject();

    events.emit("SIGTERM", "SIGTERM");
    await settle();

    expect(release).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
    const reported = lines.find((line) => line.fields["event"] === "worker.stopping");
    expect(reported?.level).toBe("warn");
    expect(reported?.fields["signal"]).toBe("SIGTERM");
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

  it("still exits, non-zero, when the release hangs", async () => {
    const { lifecycle, exit, lines } = subject({
      release: () => new Promise<void>(() => {}),
      releaseTimeoutMs: 10,
    });

    await lifecycle.shutdown({ kind: "signal", signal: "SIGTERM" });

    expect(exit).toHaveBeenCalledWith(UNREQUESTED_SHUTDOWN_EXIT_CODE);
    expect(lines.find((line) => line.fields["event"] === "worker.shutdown-failed")).toBeDefined();
  });

  it("still exits, non-zero, when the release throws", async () => {
    const { lifecycle, exit } = subject({
      release: () => Promise.reject(new Error("the pool would not close")),
    });

    await lifecycle.shutdown({ kind: "signal", signal: "SIGINT" });

    expect(exit).toHaveBeenCalledWith(UNREQUESTED_SHUTDOWN_EXIT_CODE);
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

  it("says no when the module was merely imported", () => {
    expect(isEntrypoint(pathToFileURL(file("library.js")).href, file("other.js"))).toBe(false);
    expect(isEntrypoint(pathToFileURL(file("solo.js")).href, undefined)).toBe(false);
    expect(isEntrypoint(pathToFileURL(file("empty.js")).href, "")).toBe(false);
  });
});
