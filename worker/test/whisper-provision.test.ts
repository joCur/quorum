import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  ensureWhisperModel,
  ModelProvisioningError,
  type EnsureWhisperModelOptions,
  type ProvisioningLogger,
} from "../src/whisper/provision.js";

interface LoggedLine {
  level: "info" | "warn";
  event: unknown;
  fields: Record<string, unknown>;
}

function recordingLogger(): { logger: ProvisioningLogger; lines: LoggedLine[] } {
  const lines: LoggedLine[] = [];
  const record =
    (level: "info" | "warn") =>
    (fields: Record<string, unknown>): void => {
      lines.push({ level, event: fields["event"], fields });
    };
  return { logger: { info: record("info"), warn: record("warn") }, lines };
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

  it("reports a download that claims success but leaves the model unlisted", async () => {
    const { run } = harness((call) =>
      call.method === "POST" ? new Response("ok") : modelList("Systran/faster-whisper-tiny"),
    );

    const error = (await run().catch((caught: unknown) => caught)) as ModelProvisioningError;

    expect(error).toBeInstanceOf(ModelProvisioningError);
    expect(error.reason).toBe("not-installed");
  });

  it("leaves a backend without an OpenAI-compatible model listing alone", async () => {
    // A host-native server (whisper.cpp, mlx-whisper) answers the route but not
    // with a model list; blocking startup on that would break a documented
    // development path for no gain.
    const { run, calls, lines } = harness(() => Response.json({ status: "ok" }));

    await expect(run()).resolves.toMatchObject({ status: "unsupported" });
    expect(calls).toHaveLength(1);
    expect(lines.map((line) => line.event)).toContain("whisper.model.provisioning-unsupported");
  });

  it("leaves a backend that has no model route at all alone", async () => {
    const { run, calls } = harness(() => new Response("not found", { status: 404 }));

    await expect(run()).resolves.toMatchObject({ status: "unsupported" });
    // Immediately, rather than retrying a route that will never appear.
    expect(calls).toHaveLength(1);
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
});
