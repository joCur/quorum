import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { logQueueError, type ErrorLogger } from "../src/observability/logging.js";
import { PgBossJobQueue } from "../src/recording/queue/pg-boss.js";

/** Emits on the `error` channel the way pg-boss does, and records the rest. */
class FakeBoss extends EventEmitter {
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async createQueue(): Promise<void> {}
  async send(): Promise<string> {
    return "job-id";
  }
}

function capturingLogger(): {
  logger: ErrorLogger;
  lines: Array<{ fields: Record<string, unknown>; message: string }>;
} {
  const lines: Array<{ fields: Record<string, unknown>; message: string }> = [];
  return {
    logger: {
      error(fields, message) {
        lines.push({ fields, message });
      },
    },
    lines,
  };
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

function queueOver(boss: FakeBoss): PgBossJobQueue {
  return new PgBossJobQueue(boss as unknown as ConstructorParameters<typeof PgBossJobQueue>[0]);
}

describe("pg-boss error logging", () => {
  it("logs message, code and stack", () => {
    const { logger, lines } = capturingLogger();

    logQueueError(logger, connectionTerminated());

    expect(lines[0]?.fields.event).toBe("queue.error");
    expect(lines[0]?.fields.message).toBe("Connection terminated unexpectedly");
    expect(lines[0]?.fields.code).toBe("57P01");
    expect(String(lines[0]?.fields.stack)).toContain("queue-error-logging.test.ts");
  });

  it("leaves the error's own properties out of the line", () => {
    const { logger, lines } = capturingLogger();

    logQueueError(logger, connectionTerminated());

    // Serialized the naive way this carries the whole connection state, password included.
    const serialized = JSON.stringify(lines[0]?.fields);
    expect(serialized).not.toContain("huge");
    expect(serialized).not.toContain(LEAK_CANARY);
  });

  it("still logs something that is not an Error", () => {
    const { logger, lines } = capturingLogger();

    logQueueError(logger, "connection lost");

    expect(lines[0]?.fields.message).toBe("connection lost");
    expect(lines[0]?.fields).not.toHaveProperty("code");
  });
});

describe("started queue", () => {
  it("reports a channel error instead of letting it end the process", async () => {
    const boss = new FakeBoss();
    const { logger, lines } = capturingLogger();
    await queueOver(boss).start(logger);

    // Unhandled, this `error` event would be rethrown by the EventEmitter and take the API down.
    expect(() => boss.emit("error", connectionTerminated())).not.toThrow();
    expect(lines).toHaveLength(1);
    expect(lines[0]?.fields.code).toBe("57P01");
  });

  it("survives a channel error even without a logger", async () => {
    const boss = new FakeBoss();
    await queueOver(boss).start();

    expect(() => boss.emit("error", new Error("connection terminated"))).not.toThrow();
  });
});
