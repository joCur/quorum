import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Dispatcher } from "undici";
import { loadConfig } from "../src/config.js";
import type * as TimeoutFetchModule from "../src/http/timeout-fetch.js";

// Spies on the real implementation rather than replacing it: the tests below
// that talk to an actual HTTP server still run over the real transport.
vi.mock("../src/http/timeout-fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof TimeoutFetchModule>();
  return { ...actual, createFetchWithTimeouts: vi.fn(actual.createFetchWithTimeouts) };
});

import {
  TIMEOUT_HEADROOM_MS,
  createFetchWithTimeouts,
  transportTimeoutsFor,
} from "../src/http/timeout-fetch.js";
import { OpenAiTranscriptionClient } from "../src/whisper/client.js";
import { OpenAiChatClient } from "../src/summary/chat-client.js";
import { VERBOSE_RESPONSE_WITH_WORDS } from "./helpers.js";

/** The default this exists to escape: undici aborts at 300s without a dispatcher. */
const UNDICI_DEFAULT_HEADERS_TIMEOUT_MS = 300_000;

const minimalEnv = {
  DATABASE_URL: "postgres://quorum@localhost:5432/quorum",
  S3_ENDPOINT: "http://localhost:9000",
  S3_BUCKET: "recordings",
  S3_ACCESS_KEY: "key",
  S3_SECRET_KEY: "secret",
};

/** Records the pool configuration instead of opening sockets. */
function recordingDispatcherFactory(): {
  seen: () => { headersTimeout: number; bodyTimeout: number }[];
  create: (timeouts: { headersTimeout: number; bodyTimeout: number }) => Dispatcher;
} {
  const calls: { headersTimeout: number; bodyTimeout: number }[] = [];
  return {
    seen: () => calls,
    create: (timeouts) => {
      calls.push(timeouts);
      return {} as Dispatcher;
    },
  };
}

describe("transport timeouts", () => {
  it("lets the configured transcription timeout reach the dispatcher", () => {
    const config = loadConfig(minimalEnv);
    const factory = recordingDispatcherFactory();
    createFetchWithTimeouts(config.WHISPER_TIMEOUT_MS, factory.create);

    // Both timers have to move: undici applies `headersTimeout` while the
    // backend computes and `bodyTimeout` while it answers.
    expect(factory.seen()).toEqual([
      {
        headersTimeout: config.WHISPER_TIMEOUT_MS + TIMEOUT_HEADROOM_MS,
        bodyTimeout: config.WHISPER_TIMEOUT_MS + TIMEOUT_HEADROOM_MS,
      },
    ]);
  });

  it("lets the configured summary timeout reach the dispatcher", () => {
    const config = loadConfig({ ...minimalEnv, SUMMARY_TIMEOUT_MS: "900000" });
    const factory = recordingDispatcherFactory();
    createFetchWithTimeouts(config.SUMMARY_TIMEOUT_MS, factory.create);

    expect(factory.seen()[0]).toEqual({ headersTimeout: 930_000, bodyTimeout: 930_000 });
  });

  it("keeps the caller's own budget the limit that fires first", () => {
    // Headroom, not a multiplier: the transport must never abort a request the
    // client is still willing to wait for, because that abort would be mapped
    // as a backend outage and retried.
    const timeouts = transportTimeoutsFor(600_000);
    expect(timeouts.headersTimeout).toBeGreaterThan(600_000);
    expect(timeouts.bodyTimeout).toBeGreaterThan(600_000);
  });

  it("raises the ceiling above the undici default for the shipped transcription default", () => {
    // The regression this pins: a 30-minute default that undici cut to 5.
    const config = loadConfig(minimalEnv);
    expect(config.WHISPER_TIMEOUT_MS).toBeGreaterThan(UNDICI_DEFAULT_HEADERS_TIMEOUT_MS);
    expect(transportTimeoutsFor(config.WHISPER_TIMEOUT_MS).headersTimeout).toBeGreaterThan(
      UNDICI_DEFAULT_HEADERS_TIMEOUT_MS,
    );
  });
});

describe("client transport wiring", () => {
  it("builds the transcription transport from the configured timeout", () => {
    const config = loadConfig({ ...minimalEnv, WHISPER_TIMEOUT_MS: "1200000" });
    vi.mocked(createFetchWithTimeouts).mockClear();
    new OpenAiTranscriptionClient({
      baseUrl: "http://whisper:8000/v1",
      model: "small",
      timeoutMs: config.WHISPER_TIMEOUT_MS,
    });
    // Without this the client would fall back to the global `fetch`, whose
    // undici default ends every request after five minutes.
    expect(createFetchWithTimeouts).toHaveBeenCalledWith(1_200_000);
  });

  it("builds the summary transport from the configured timeout", () => {
    const config = loadConfig({ ...minimalEnv, SUMMARY_TIMEOUT_MS: "600000" });
    vi.mocked(createFetchWithTimeouts).mockClear();
    new OpenAiChatClient({
      baseUrl: "https://openrouter.ai/api/v1",
      model: "test-model",
      timeoutMs: config.SUMMARY_TIMEOUT_MS,
    });
    expect(createFetchWithTimeouts).toHaveBeenCalledWith(600_000);
  });

  it("leaves an injected transport alone", () => {
    vi.mocked(createFetchWithTimeouts).mockClear();
    new OpenAiTranscriptionClient({
      baseUrl: "http://whisper:8000/v1",
      model: "small",
      fetchImpl: async () => new Response("{}"),
    });
    expect(createFetchWithTimeouts).not.toHaveBeenCalled();
  });
});

describe("clients over the real transport", () => {
  let server: Server | undefined;
  let received: { contentType: string | undefined; body: Buffer } | undefined;

  afterEach(async () => {
    if (server) await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    received = undefined;
  });

  /** A backend that computes first and only then sends response headers. */
  async function backendAnsweringAfter(delayMs: number, payload: unknown): Promise<string> {
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received = {
          contentType: request.headers["content-type"],
          body: Buffer.concat(chunks),
        };
        setTimeout(() => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
        }, delayMs);
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", () => resolve()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  }

  it("transcribes over a backend that answers only after a delay", async () => {
    const baseUrl = await backendAnsweringAfter(150, VERBOSE_RESPONSE_WITH_WORDS);
    // No `fetchImpl`: this exercises the dispatcher-backed default transport.
    const response = await new OpenAiTranscriptionClient({
      baseUrl,
      model: "small",
      timeoutMs: 10_000,
    }).transcribe({
      audio: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
      filename: "recording.webm",
      contentType: "audio/webm",
    });
    expect(response.segments?.[0]?.words).toHaveLength(3);

    // The multipart body has to survive the transport. undici encodes a
    // `FormData` it did not create as the string "[object FormData]", which
    // would leave the request valid and the audio behind.
    const sent = received!.body.toString("latin1");
    expect(received!.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(sent).toContain('name="file"; filename="recording.webm"');
    expect(sent).toContain('name="model"');
    expect(sent).toContain('name="vad_filter"');
  });

  it("still maps its own timeout to a retryable failure", async () => {
    const baseUrl = await backendAnsweringAfter(5_000, VERBOSE_RESPONSE_WITH_WORDS);
    await expect(
      new OpenAiTranscriptionClient({ baseUrl, model: "small", timeoutMs: 100 }).transcribe({
        audio: new Uint8Array([0x1a]),
        filename: "recording.webm",
        contentType: "audio/webm",
      }),
    ).rejects.toMatchObject({ code: "TRANSCRIPTION_UNAVAILABLE", retryable: true });
  });

  it("summarizes over a backend that answers only after a delay", async () => {
    const baseUrl = await backendAnsweringAfter(150, {
      model: "test-model",
      choices: [{ finish_reason: "stop", message: { content: "{}" } }],
    });
    const result = await new OpenAiChatClient({
      baseUrl,
      model: "test-model",
      timeoutMs: 10_000,
    }).complete([{ role: "user", content: "hello" }]);
    expect(result.content).toBe("{}");
  });
});
