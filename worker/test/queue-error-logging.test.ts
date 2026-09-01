import { describe, expect, it } from "vitest";
import { pino } from "pino";
import { logQueueError, type WorkerLogger } from "../src/logger.js";

/** A logger that keeps its lines, so what would reach stdout can be asserted verbatim. */
function capturingLogger(): { log: WorkerLogger; lines: string[] } {
  const lines: string[] = [];
  const log = pino(
    { level: "error", base: null },
    {
      write(line: string) {
        lines.push(line);
      },
    },
  );
  return { log, lines };
}

/** Marks the deepest field of the client object; assigned indirectly so no secret scanner reads
 * the fixture as a real credential. */
const LEAK_CANARY = "leak-canary-value";

/**
 * The shape that makes the naive `{ err }` logging expensive: pg hangs its whole `Client` off a
 * dropped-connection error as an own enumerable property.
 */
function connectionTerminated(): Error {
  return Object.assign(new Error("Connection terminated unexpectedly"), {
    code: "57P01",
    client: { huge: "object", connectionParameters: { password: LEAK_CANARY } },
  });
}

describe("pg-boss error logging", () => {
  it("logs message, code and stack", () => {
    const { log, lines } = capturingLogger();

    logQueueError(log, connectionTerminated());

    const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(entry.event).toBe("queue.error");
    expect(entry.message).toBe("Connection terminated unexpectedly");
    expect(entry.code).toBe("57P01");
    expect(entry.stack).toContain("queue-error-logging.test.ts");
  });

  it("leaves the error's own properties out of the line", () => {
    const { log, lines } = capturingLogger();

    logQueueError(log, connectionTerminated());

    // One `docker compose down` emits one of these per pooled connection; the client object would
    // make each of them kilobytes long — and would print the connection password.
    expect(lines[0]).not.toContain("huge");
    expect(lines[0]).not.toContain(LEAK_CANARY);
    expect(lines[0]?.length).toBeLessThan(2_000);
  });

  it("still logs something that is not an Error", () => {
    const { log, lines } = capturingLogger();

    logQueueError(log, "connection lost");

    const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(entry.message).toBe("connection lost");
    expect(entry.code).toBeUndefined();
  });

  it("omits a code that is not one", () => {
    const { log, lines } = capturingLogger();

    logQueueError(log, new Error("plain"));

    const entry = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
    expect(entry.message).toBe("plain");
    expect(entry).not.toHaveProperty("code");
  });
});
