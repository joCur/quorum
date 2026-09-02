import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as TimeoutFetchModule from "../src/http/timeout-fetch.js";

// Spies on the real implementation rather than replacing it, so the test that
// talks to an actual HTTP server still runs over the real transport.
vi.mock("../src/http/timeout-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof TimeoutFetchModule>();
  return { ...actual, createFetchWithTimeouts: vi.fn(actual.createFetchWithTimeouts) };
});

import { loadConfig } from "../src/config.js";
import {
  BODY_IDLE_TIMEOUT_MS,
  createFetchWithTimeouts,
  transportTimeoutsFor,
} from "../src/http/timeout-fetch.js";
import {
  createLifecycle,
  UNREQUESTED_SHUTDOWN_EXIT_CODE,
  type ReleaseOptions,
} from "../src/lifecycle.js";
import type { WorkerLogger } from "../src/logger.js";
import {
  ensureWhisperModel,
  ModelProvisioningError,
  PROVISIONING_FAILED_EVENT,
  type EnsureWhisperModelOptions,
  type ProvisioningLogger,
} from "../src/whisper/provision.js";

/** The default this transport exists to escape: undici gives up at 300s. */
const UNDICI_DEFAULT_HEADERS_TIMEOUT_MS = 300_000;

type Level = "info" | "warn" | "fatal" | "error";

interface LoggedLine {
  level: Level;
  event: unknown;
  message: string;
  fields: Record<string, unknown>;
}

function recordingLogger(): { logger: ProvisioningLogger; lines: LoggedLine[] } {
  const lines: LoggedLine[] = [];
  const record =
    (level: Level) =>
    (fields: Record<string, unknown>, message: string): void => {
      lines.push({ level, event: fields["event"], message, fields });
    };
  return {
    logger: { info: record("info"), warn: record("warn"), fatal: record("fatal") },
    lines,
  };
}

/** A logger that is both the narrow provisioning port and a pino-shaped one. */
function sharedLogger(): { logger: ProvisioningLogger & WorkerLogger; lines: LoggedLine[] } {
  const lines: LoggedLine[] = [];
  const record =
    (level: Level) =>
    (fields: Record<string, unknown>, message: string): void => {
      lines.push({ level, event: fields["event"], message, fields });
    };
  return {
    logger: {
      debug: record("info"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
      fatal: record("fatal"),
    } as unknown as ProvisioningLogger & WorkerLogger,
    lines,
  };
}

/** For the cases whose subject is the HTTP behavior, not what was said about it. */
function silentLogger(): ProvisioningLogger {
  return { info: () => {}, warn: () => {}, fatal: () => {} };
}

interface Call {
  url: string;
  method: string;
  authorization: string | null;
}

/** A fake backend plus a clock that only moves when the code under test waits. */
function harness(
  responder: (call: Call, index: number) => Response | Promise<Response>,
  overrides: Partial<EnsureWhisperModelOptions> = {},
): {
  run: () => Promise<Awaited<ReturnType<typeof ensureWhisperModel>>>;
  calls: Call[];
  lines: LoggedLine[];
} {
  const calls: Call[] = [];
  const { logger, lines } = recordingLogger();
  let clock = 0;

  const options: EnsureWhisperModelOptions = {
    baseUrl: "http://whisper:8000/v1",
    model: "Systran/faster-whisper-small",
    logger,
    retryDelayMs: 1_000,
    timeoutMs: 10_000,
    fetchImpl: async (input, init) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization"),
      };
      calls.push(call);
      return await responder(call, calls.length - 1);
    },
    now: () => clock,
    // Waiting is the only thing that moves the clock, so a retry loop cannot
    // spin forever and the deadline is reached deterministically.
    sleep: async (ms: number) => {
      clock += ms;
    },
    ...overrides,
  };

  return { run: () => ensureWhisperModel(options), calls, lines };
}

function modelList(...ids: string[]): Response {
  return Response.json({
    object: "list",
    data: ids.map((id) => ({ id, object: "model", owned_by: "test" })),
  });
}

/** What the backend answers for a model it has never heard of. */
function unknownModel(id: string): Response {
  return Response.json({ detail: `Model '${id}' not found` }, { status: 404 });
}

describe("Whisper model provisioning", () => {
  it("does nothing when the configured model is already installed", async () => {
    const { run, calls, lines } = harness(() =>
      modelList("Systran/faster-whisper-tiny", "Systran/faster-whisper-small"),
    );

    await expect(run()).resolves.toEqual({ status: "present" });
    // A restart on a warm model volume costs exactly one listing request.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "http://whisper:8000/v1/models", method: "GET" });
    expect(lines.map((line) => line.event)).toContain("whisper.model.present");
  });

  it("downloads a missing model and verifies that it is installed afterwards", async () => {
    const { run, calls, lines } = harness((call) => {
      if (call.method === "POST") return new Response("Model downloaded");
      return calls.length === 1
        ? modelList("Systran/faster-whisper-tiny")
        : modelList("Systran/faster-whisper-tiny", "Systran/faster-whisper-small");
    });

    const outcome = await run();

    expect(outcome.status).toBe("installed");
    expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET http://whisper:8000/v1/models",
      // The slash in the model ID stays a path separator — the backend addresses
      // models by their full `owner/name`.
      "POST http://whisper:8000/v1/models/Systran/faster-whisper-small",
      "GET http://whisper:8000/v1/models",
    ]);
    expect(lines.map((line) => line.event)).toEqual([
      "whisper.model.install-started",
      "whisper.model.installed",
    ]);
  });

  it("escapes everything in a model ID except the owner separator", async () => {
    const { run, calls } = harness(
      (call, index) =>
        call.method === "POST"
          ? new Response("ok")
          : index === 0
            ? modelList()
            : modelList("owner/a b?c"),
      { model: "owner/a b?c" },
    );

    await run();
    expect(calls[1]?.url).toBe("http://whisper:8000/v1/models/owner/a%20b%3Fc");
  });

  it("fails loudly on a model the backend does not know, naming the ID and how to list valid ones", async () => {
    const { run, lines } = harness(
      (call) =>
        call.method === "POST" ? unknownModel("small") : modelList("Systran/faster-whisper-small"),
      { model: "small" },
    );

    const error = await run().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ModelProvisioningError);
    const failure = error as ModelProvisioningError;
    expect(failure.reason).toBe("model-unknown");
    expect(failure.model).toBe("small");
    expect(failure.message).toContain('"small"');
    // The operator has to be able to act on the line alone.
    expect(failure.message).toContain("full model ID");
    expect(failure.message).toContain(
      "http://whisper:8000/v1/registry?task=automatic-speech-recognition",
    );
    // A typo is not retried: the loop would only delay the fix.
    expect(lines.map((line) => line.event)).not.toContain("whisper.model.install-retry");
  });

  it("waits for a backend that is still starting, then provisions", async () => {
    const { run, calls, lines } = harness((call, index) => {
      if (index < 3) throw new Error("connect ECONNREFUSED 172.18.0.5:8000");
      if (call.method === "POST") return new Response("ok");
      return index === 3 ? modelList() : modelList("Systran/faster-whisper-small");
    });

    await expect(run()).resolves.toMatchObject({ status: "installed" });
    expect(calls).toHaveLength(6);
    expect(lines.map((line) => line.event)).toContain("whisper.model.waiting");
  });

  it("gives up when the backend never answers within the budget", async () => {
    const { run } = harness(() => {
      throw new Error("connect ECONNREFUSED");
    });

    const error = (await run().catch((caught: unknown) => caught)) as ModelProvisioningError;

    expect(error).toBeInstanceOf(ModelProvisioningError);
    expect(error.reason).toBe("backend-unreachable");
    expect(error.message).toContain("ECONNREFUSED");
  });

  it("retries a download that fails transiently", async () => {
    let posts = 0;
    const { run, lines } = harness((call, index) => {
      if (call.method === "POST") {
        posts += 1;
        return posts === 1 ? new Response("busy", { status: 503 }) : new Response("ok");
      }
      return index === 0 ? modelList() : modelList("Systran/faster-whisper-small");
    });

    await expect(run()).resolves.toMatchObject({ status: "installed" });
    expect(posts).toBe(2);
    expect(lines.map((line) => line.event)).toContain("whisper.model.install-retry");
  });

  it("waits for the listing to catch up with a download instead of failing on the first read", async () => {
    // The download answers when the bytes are on disk; nothing promises the
    // listing is updated in the same instant, and a backend that installs
    // asynchronously would otherwise restart-loop over a download that worked.
    let listings = 0;
    const { run } = harness((call) => {
      if (call.method === "POST") return new Response("ok");
      listings += 1;
      return listings > 3 ? modelList("Systran/faster-whisper-small") : modelList();
    });

    await expect(run()).resolves.toMatchObject({ status: "installed" });
    expect(listings).toBe(4);
  });

  it("reports a download that claims success but never shows up in the listing", async () => {
    let listings = 0;
    const { run } = harness((call) => {
      if (call.method === "POST") return new Response("ok");
      listings += 1;
      return modelList("Systran/faster-whisper-tiny");
    });

    const error = (await run().catch((caught: unknown) => caught)) as ModelProvisioningError;

    expect(error).toBeInstanceOf(ModelProvisioningError);
    expect(error.reason).toBe("not-installed");
    // Given real grace before the verdict, not decided on one read.
    expect(listings).toBeGreaterThan(2);
  });

  it("accepts a listing that spells the model ID differently, and says so", async () => {
    const { run, lines } = harness(() => modelList("Systran/Faster-Whisper-Small"));

    await expect(run()).resolves.toEqual({ status: "present" });
    // Re-downloading a model that is already there, forever, is the alternative.
    const mismatch = lines.find((line) => line.event === "whisper.model.id-case-mismatch");
    expect(mismatch?.fields["backendModelId"]).toBe("Systran/Faster-Whisper-Small");
  });

  it("does not conclude from a single 404 that the backend has no model listing", async () => {
    // A reverse proxy whose upstream route is not registered yet answers exactly
    // like a backend that has no such route. Believing the first one would switch
    // provisioning off in the deployments that need it most.
    const { run, lines } = harness((call, index) => {
      if (call.method === "POST") return new Response("ok");
      if (index < 2) return new Response("not found", { status: 404 });
      return index === 2 ? modelList() : modelList("Systran/faster-whisper-small");
    });

    await expect(run()).resolves.toMatchObject({ status: "installed" });
    expect(lines.map((line) => line.event)).not.toContain("whisper.model.provisioning-unsupported");
  });

  it("leaves a backend alone once the missing route has proven itself missing", async () => {
    // A host-native server (whisper.cpp, mlx-whisper) has no model management at
    // all; blocking startup on that would break a documented development path.
    const { run, calls, lines } = harness(() => new Response("not found", { status: 404 }));

    await expect(run()).resolves.toMatchObject({ status: "unsupported" });
    expect(calls.length).toBeGreaterThan(2);
    const skipped = lines.find((line) => line.event === "whisper.model.provisioning-unsupported");
    // The operator has to be told how to turn the skip into a decision.
    expect(skipped?.message).toContain("WHISPER_MODEL_AUTO_INSTALL=false");
  });

  it("treats an unrecognizable model listing the same way", async () => {
    const { run, calls } = harness(() => Response.json({ status: "ok" }));

    await expect(run()).resolves.toMatchObject({ status: "unsupported" });
    expect(calls.length).toBeGreaterThan(2);
  });

  it("fails immediately when the backend refuses the credentials", async () => {
    const { run, calls } = harness(() => new Response("nope", { status: 401 }));

    const error = (await run().catch((caught: unknown) => caught)) as ModelProvisioningError;

    expect(error).toBeInstanceOf(ModelProvisioningError);
    expect(error.reason).toBe("unauthorized");
    expect(error.message).toContain("WHISPER_API_KEY");
    // Deterministic: waiting out the whole budget would only delay the fix.
    expect(calls).toHaveLength(1);
  });

  it("fails immediately when the download is refused for the credentials", async () => {
    const { run } = harness((call) =>
      call.method === "POST" ? new Response("nope", { status: 403 }) : modelList(),
    );

    const error = (await run().catch((caught: unknown) => caught)) as ModelProvisioningError;

    expect(error.reason).toBe("unauthorized");
  });

  it("warns rather than fails when the listing cannot be re-read after a download", async () => {
    const { run, lines } = harness((call, index) => {
      if (call.method === "POST") return new Response("ok");
      if (index === 0) return modelList();
      throw new Error("connection reset");
    });

    await expect(run()).resolves.toMatchObject({ status: "installed" });
    expect(lines.map((line) => line.event)).toContain("whisper.model.verify-skipped");
  });

  it("contacts nothing when provisioning is turned off", async () => {
    const { run, calls, lines } = harness(() => modelList(), { enabled: false });

    await expect(run()).resolves.toEqual({ status: "disabled" });
    expect(calls).toHaveLength(0);
    expect(lines.map((line) => line.event)).toEqual(["whisper.model.provisioning-disabled"]);
  });

  it("sends the configured bearer token", async () => {
    const { run, calls } = harness(() => modelList("Systran/faster-whisper-small"), {
      apiKey: "secret",
    });

    await run();
    expect(calls[0]?.authorization).toBe("Bearer secret");
  });

  it("reports that a long download is still running", async () => {
    const { run, lines } = harness(
      async (call, index) => {
        if (call.method === "POST") {
          await new Promise((resolve) => setTimeout(resolve, 60));
          return new Response("ok");
        }
        return index === 0 ? modelList() : modelList("Systran/faster-whisper-small");
      },
      { progressIntervalMs: 5 },
    );

    await run();
    // A startup that prints nothing for half an hour looks like a hang.
    expect(
      lines.filter((line) => line.event === "whisper.model.install-progress").length,
    ).toBeGreaterThan(0);
  });
});

describe("provisioning configuration", () => {
  const base = {
    DATABASE_URL: "postgres://localhost/quorum",
    S3_ENDPOINT: "http://minio:9000",
    S3_BUCKET: "recordings",
    S3_ACCESS_KEY: "key",
    S3_SECRET_KEY: "secret",
  };

  it("provisions by default, because a fresh deployment is the case that fails", () => {
    const config = loadConfig({ ...base });
    expect(config.WHISPER_MODEL_AUTO_INSTALL).toBe(true);
    expect(config.WHISPER_MODEL_INSTALL_TIMEOUT_MS).toBe(45 * 60_000);
  });

  it("can be turned off for an operator-managed model cache", () => {
    const config = loadConfig({ ...base, WHISPER_MODEL_AUTO_INSTALL: "false" });
    expect(config.WHISPER_MODEL_AUTO_INSTALL).toBe(false);
  });

  it("refuses a provisioning budget larger than a timer can hold", () => {
    // An operator reaching for a bigger number wants more patience. Past this
    // ceiling `setTimeout` truncates and fires immediately, so the budget would
    // abort the first request after a millisecond and fail the whole startup —
    // the exact opposite of what was asked for, with no hint as to why.
    expect(() =>
      loadConfig({ ...base, WHISPER_MODEL_INSTALL_TIMEOUT_MS: "2147483648" }),
    ).toThrowError(/WHISPER_MODEL_INSTALL_TIMEOUT_MS/);
  });

  it("accepts the largest provisioning budget a timer can hold", () => {
    const config = loadConfig({ ...base, WHISPER_MODEL_INSTALL_TIMEOUT_MS: "2147483647" });
    expect(config.WHISPER_MODEL_INSTALL_TIMEOUT_MS).toBe(2_147_483_647);
  });
});

describe("provisioning transport", () => {
  const base = {
    DATABASE_URL: "postgres://localhost/quorum",
    S3_ENDPOINT: "http://minio:9000",
    S3_BUCKET: "recordings",
    S3_ACCESS_KEY: "key",
    S3_SECRET_KEY: "secret",
  };

  const logger = silentLogger();

  it("builds its transport from the configured provisioning budget", async () => {
    const config = loadConfig({ ...base, WHISPER_MODEL_INSTALL_TIMEOUT_MS: "1200000" });
    vi.mocked(createFetchWithTimeouts).mockClear();
    // Stands in for the pool, so the assertion also proves the returned
    // transport is the one actually used rather than merely constructed.
    vi.mocked(createFetchWithTimeouts).mockReturnValueOnce(async () =>
      Response.json({ object: "list", data: [{ id: "Systran/faster-whisper-small" }] }),
    );

    await expect(
      ensureWhisperModel({
        baseUrl: "http://whisper:8000/v1",
        model: "Systran/faster-whisper-small",
        timeoutMs: config.WHISPER_MODEL_INSTALL_TIMEOUT_MS,
        logger,
      }),
    ).resolves.toEqual({ status: "present" });

    // Without this the download would run on the global `fetch`, whose undici
    // default ends the request after five minutes no matter what is configured.
    expect(createFetchWithTimeouts).toHaveBeenCalledWith(1_200_000);
  });

  it("leaves an injected transport alone", async () => {
    vi.mocked(createFetchWithTimeouts).mockClear();

    await ensureWhisperModel({
      baseUrl: "http://whisper:8000/v1",
      model: "m",
      logger,
      fetchImpl: async () => Response.json({ object: "list", data: [{ id: "m" }] }),
    });

    expect(createFetchWithTimeouts).not.toHaveBeenCalled();
  });

  it("raises the header ceiling above the undici default for the shipped budget", () => {
    const config = loadConfig(base);
    const timeouts = transportTimeoutsFor(config.WHISPER_MODEL_INSTALL_TIMEOUT_MS);

    expect(timeouts.headersTimeout).toBeGreaterThan(UNDICI_DEFAULT_HEADERS_TIMEOUT_MS);
    // The body timer is an idle gap between chunks, not a total, so it stays
    // small however long the download itself is allowed to take.
    expect(timeouts.bodyTimeout).toBe(BODY_IDLE_TIMEOUT_MS);
  });
});

describe("provisioning over the real transport", () => {
  let server: Server | undefined;

  afterEach(async () => {
    const running = server;
    server = undefined;
    if (running) await new Promise<void>((resolve) => running.close(() => resolve()));
  });

  /** A backend that answers the download only after it has "finished" it. */
  async function startBackend(installDelayMs: number): Promise<string> {
    let installed = false;
    server = createServer((request, response) => {
      request.resume();
      if (request.method === "POST") {
        setTimeout(() => {
          installed = true;
          response.writeHead(200, { "content-type": "application/json" });
          response.end('"Model downloaded"');
        }, installDelayMs);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          object: "list",
          data: installed ? [{ id: "Systran/faster-whisper-small" }] : [],
        }),
      );
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server?.address() as AddressInfo).port}/v1`;
  }

  it("survives a download that sends no response header until it is done", async () => {
    // The shape that broke on the global transport: the backend holds the
    // connection open, silent, for the whole download. Short here, hours on a
    // real one — the transport is what makes the difference a matter of the
    // configured budget rather than a fixed five minutes.
    const baseUrl = await startBackend(300);

    const outcome = await ensureWhisperModel({
      baseUrl,
      model: "Systran/faster-whisper-small",
      timeoutMs: 20_000,
      retryDelayMs: 10,
      logger: silentLogger(),
    });

    expect(outcome.status).toBe("installed");
  });

  it("ends a download that never answers on its own budget, not the transport's", async () => {
    // The transport's header ceiling sits 30s above the budget on purpose, so
    // the abort signal is what stops a hopeless download. That ordering is what
    // keeps an exhausted budget legible as an exhausted budget rather than as a
    // transport-level error that reads like a backend outage.
    const baseUrl = await startBackend(60_000);

    const error = (await ensureWhisperModel({
      baseUrl,
      model: "Systran/faster-whisper-small",
      timeoutMs: 700,
      retryDelayMs: 10,
      logger: silentLogger(),
    }).catch((caught: unknown) => caught)) as ModelProvisioningError;

    expect(error).toBeInstanceOf(ModelProvisioningError);
    expect(error.reason).toBe("install-failed");
    expect(error.message).toMatch(/abort/i);
  });
});

describe("a provisioning failure and the shutdown guard", () => {
  /**
   * Mirrors how `main` wires the guard: a stack of release closures, newest
   * last, and a startup whose throw is handed to `startup-failed`. The real
   * `createLifecycle` and the real `ensureWhisperModel` are on both ends, so
   * what is asserted below is the arrangement rather than a restatement of it.
   *
   * The startup body stops where `start` stops being reproducible without a
   * database: it takes hold of two things and then provisions.
   */
  async function startupThatCannotProvision(): Promise<{
    lines: LoggedLine[];
    exit: ReturnType<typeof vi.fn>;
    released: string[];
    releaseOptions: ReleaseOptions[];
  }> {
    const { logger, lines } = sharedLogger();
    const exit = vi.fn();
    const released: string[] = [];
    const releaseOptions: ReleaseOptions[] = [];

    const held: Array<(options: ReleaseOptions) => Promise<void>> = [];
    const lifecycle = createLifecycle({
      logger,
      release: async (options) => {
        for (const give of [...held].reverse()) await give(options);
      },
      exit,
    });

    try {
      held.push(async (options) => {
        released.push("database pool");
        releaseOptions.push(options);
      });
      held.push(async () => {
        released.push("metrics port");
      });
      await ensureWhisperModel({
        baseUrl: "http://whisper:8000/v1",
        model: "small",
        logger,
        timeoutMs: 10_000,
        retryDelayMs: 1_000,
        // A model ID the backend does not know: terminal on the first answer,
        // which is the failure an operator is most likely to actually cause.
        fetchImpl: async (_input, init) =>
          init?.method === "POST"
            ? Response.json({ detail: "Model 'small' not found" }, { status: 404 })
            : Response.json({ object: "list", data: [] }),
      });
    } catch (error: unknown) {
      await lifecycle.shutdown({ kind: "startup-failed", error });
    }

    return { lines, exit, released, releaseOptions };
  }

  it("routes the failure through the guard instead of exiting on its own", async () => {
    const { lines } = await startupThatCannotProvision();

    const stopping = lines.find((line) => line.event === "worker.stopping");
    expect(stopping?.fields["reason"]).toBe("startup-failed");
    // At error level, which every threshold we deploy with shows.
    expect(stopping?.level).toBe("error");
  });

  it("gives back what the startup had already taken, newest first", async () => {
    const { released, releaseOptions } = await startupThatCannotProvision();

    expect(released).toEqual(["metrics port", "database pool"]);
    // A fault is not a drain: there is no in-flight work to protect, and the
    // process is not trustworthy enough to wait on.
    expect(releaseOptions.every((options) => options.graceful)).toBe(false);
  });

  it("says which model and which backend before it says the startup failed", async () => {
    const { lines } = await startupThatCannotProvision();

    const specific = lines.findIndex((line) => line.event === PROVISIONING_FAILED_EVENT);
    const generic = lines.findIndex((line) => line.event === "worker.stopping");

    expect(specific).toBeGreaterThanOrEqual(0);
    // An operator reading top-down has to meet the reason before the verdict:
    // the generic line carries neither of these two fields.
    expect(specific).toBeLessThan(generic);
    expect(lines[specific]?.fields["whisperModel"]).toBe("small");
    expect(lines[specific]?.fields["whisperBaseUrl"]).toBe("http://whisper:8000/v1");
  });

  it("exits with the status that means nobody asked for this", async () => {
    const { exit } = await startupThatCannotProvision();

    // 70, not 1: a supervisor reads the code, and the worker has exactly one
    // exit status for a stop it did not choose.
    expect(exit).toHaveBeenCalledWith(UNREQUESTED_SHUTDOWN_EXIT_CODE);
    expect(exit).not.toHaveBeenCalledWith(1);
  });
});
