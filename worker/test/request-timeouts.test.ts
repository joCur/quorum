import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { createTimeoutDispatcher, requestTimeoutOptions } from "../src/http/fetch.js";
import { OpenAiChatClient } from "../src/summary/chat-client.js";
import { OpenAiTranscriptionClient } from "../src/whisper/client.js";
import { VERBOSE_RESPONSE_WITH_WORDS } from "./helpers.js";

const minimalEnv = {
  DATABASE_URL: "postgres://quorum:secret@postgres:5432/quorum",
  S3_ENDPOINT: "http://minio:9000",
  S3_BUCKET: "recordings",
  S3_ACCESS_KEY: "quorum-admin",
  S3_SECRET_KEY: "secret",
};

const audio = {
  audio: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
  filename: "recording.webm",
  contentType: "audio/webm",
};

/**
 * The configured whole-request budget has to reach the HTTP stack, because the
 * stack's own default is far shorter than a transcription: undici gives up after
 * 300 s of waiting for response headers, and a transcription backend sends none
 * until the transcript exists.
 */
describe("configured request timeouts", () => {
  it("derives both undici timeouts from the whole-request budget", () => {
    expect(requestTimeoutOptions(1_234)).toEqual({ headersTimeout: 1_234, bodyTimeout: 1_234 });
  });

  it("gives the transcription client the budget the configuration asks for", () => {
    const config = loadConfig(minimalEnv);
    expect(config.WHISPER_TIMEOUT_MS).toBe(30 * 60_000);

    const client = new OpenAiTranscriptionClient({
      baseUrl: "http://whisper:8000/v1",
      model: "large-v3",
      timeoutMs: config.WHISPER_TIMEOUT_MS,
    });
    expect(client.requestTimeouts).toEqual({
      headersTimeout: config.WHISPER_TIMEOUT_MS,
      bodyTimeout: config.WHISPER_TIMEOUT_MS,
    });
  });

  it("follows a raised WHISPER_TIMEOUT_MS instead of any built-in ceiling", () => {
    const config = loadConfig({ ...minimalEnv, WHISPER_TIMEOUT_MS: "5400000" });
    const client = new OpenAiTranscriptionClient({
      baseUrl: "http://whisper:8000/v1",
      model: "large-v3",
      timeoutMs: config.WHISPER_TIMEOUT_MS,
    });
    expect(client.requestTimeouts.headersTimeout).toBe(5_400_000);
    expect(client.requestTimeouts.bodyTimeout).toBe(5_400_000);
  });

  it("gives the summary client the budget its own configuration asks for", () => {
    const config = loadConfig(minimalEnv);
    const client = new OpenAiChatClient({
      baseUrl: "https://router.example/api/v1",
      model: "vendor/model",
      timeoutMs: config.SUMMARY_TIMEOUT_MS,
    });
    expect(client.requestTimeouts).toEqual({
      headersTimeout: config.SUMMARY_TIMEOUT_MS,
      bodyTimeout: config.SUMMARY_TIMEOUT_MS,
    });
  });

  it("sends the dispatcher along with the transcription request", async () => {
    const dispatcher = createTimeoutDispatcher(60_000);
    let seen: unknown;
    const client = new OpenAiTranscriptionClient({
      baseUrl: "http://whisper:8000/v1",
      model: "small",
      dispatcher,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        seen = init?.dispatcher;
        return Response.json(VERBOSE_RESPONSE_WITH_WORDS);
      }) as unknown as typeof fetch,
    });

    await client.transcribe(audio);
    expect(seen).toBe(dispatcher);
  });

  it("sends the dispatcher along with the summary request", async () => {
    const dispatcher = createTimeoutDispatcher(60_000);
    let seen: unknown;
    const client = new OpenAiChatClient({
      baseUrl: "https://router.example/api/v1",
      model: "vendor/model",
      dispatcher,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        seen = init?.dispatcher;
        return Response.json({
          choices: [{ finish_reason: "stop", message: { content: "{}" } }],
        });
      }) as unknown as typeof fetch,
    });

    await client.complete([{ role: "user", content: "hi" }]);
    expect(seen).toBe(dispatcher);
  });
});

/**
 * Against a real socket, because the regression this guards is a property of the
 * HTTP stack rather than of the client's own code: with the stack's default
 * timeouts nothing here can be observed, and a request outliving the wait is
 * exactly what a CPU transcription needs.
 */
describe("a backend that answers slowly", () => {
  let server: Server;
  let origin: string;
  let received: { contentType: string | undefined; body: string } | null = null;

  beforeAll(async () => {
    server = createServer((request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received = {
          contentType: request.headers["content-type"],
          body: Buffer.concat(chunks).toString("latin1"),
        };
        // Nothing is sent before this point — not even the status line, which
        // is what makes the wait a header timeout rather than a body timeout.
        const delayMs = request.url?.startsWith("/slow") === true ? 4_000 : 50;
        setTimeout(() => {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify(VERBOSE_RESPONSE_WITH_WORDS));
        }, delayMs).unref();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("uploads real multipart audio and reads the answer back", async () => {
    const client = new OpenAiTranscriptionClient({
      baseUrl: `${origin}/quick/v1`,
      model: "small",
      timeoutMs: 30_000,
    });

    const transcription = await client.transcribe(audio);
    expect(transcription.segments?.[0]?.words).toHaveLength(3);
    expect(received?.contentType).toMatch(/^multipart\/form-data; boundary=/);
    expect(received?.body).toContain('filename="recording.webm"');
    expect(received?.body).toContain("verbose_json");
  });

  it("gives up on the headers only once the request budget is spent", async () => {
    const client = new OpenAiTranscriptionClient({
      baseUrl: `${origin}/slow/v1`,
      model: "small",
      // Far beyond the wait, so the abort signal cannot be what ends the request.
      timeoutMs: 30 * 60_000,
      dispatcher: createTimeoutDispatcher(100),
    });

    await expect(client.transcribe(audio)).rejects.toMatchObject({
      code: "TRANSCRIPTION_UNAVAILABLE",
      retryable: true,
      message: expect.stringContaining("Headers Timeout Error") as unknown as string,
    });
  });
});
