import { describe, expect, it } from "vitest";
import { OpenAiChatClient } from "../src/summary/chat-client.js";
import { summaryErrorCodeForHttpStatus } from "../src/errors.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const COMPLETION = {
  model: "vendor/model-v2",
  choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"sections":[]}' } }],
  usage: { prompt_tokens: 1200, completion_tokens: 150 },
};

function clientWith(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
  options: Partial<ConstructorParameters<typeof OpenAiChatClient>[0]> = {},
) {
  const calls: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      headers: new Headers(init?.headers),
    });
    return handler(String(url), init ?? {});
  }) as unknown as typeof fetch;

  const client = new OpenAiChatClient({
    baseUrl: "https://router.example/api/v1",
    model: "vendor/model",
    fetchImpl,
    ...options,
  });
  return { client, calls };
}

describe("OpenAI-compatible chat client", () => {
  it("posts the messages to /chat/completions on the configured base URL", async () => {
    const { client, calls } = clientWith(() => jsonResponse(COMPLETION));
    await client.complete([{ role: "user", content: "hello" }]);

    expect(calls[0]!.url).toBe("https://router.example/api/v1/chat/completions");
    expect(calls[0]!.body).toMatchObject({
      model: "vendor/model",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    });
  });

  it("tolerates a base URL with a trailing slash", async () => {
    const { client, calls } = clientWith(() => jsonResponse(COMPLETION), {
      baseUrl: "http://localhost:1234/v1/",
    });
    await client.complete([{ role: "user", content: "hi" }]);
    expect(calls[0]!.url).toBe("http://localhost:1234/v1/chat/completions");
  });

  it("sends a bearer token only when one is configured", async () => {
    const withKey = clientWith(() => jsonResponse(COMPLETION), { apiKey: "sk-test" });
    await withKey.client.complete([{ role: "user", content: "hi" }]);
    expect(withKey.calls[0]!.headers.get("authorization")).toBe("Bearer sk-test");

    const withoutKey = clientWith(() => jsonResponse(COMPLETION));
    await withoutKey.client.complete([{ role: "user", content: "hi" }]);
    expect(withoutKey.calls[0]!.headers.get("authorization")).toBeNull();
  });

  it("omits response_format unless JSON mode is switched on", async () => {
    const off = clientWith(() => jsonResponse(COMPLETION));
    await off.client.complete([{ role: "user", content: "hi" }]);
    expect(off.calls[0]!.body["response_format"]).toBeUndefined();

    const on = clientWith(() => jsonResponse(COMPLETION), { jsonMode: true });
    await on.client.complete([{ role: "user", content: "hi" }]);
    expect(on.calls[0]!.body["response_format"]).toEqual({ type: "json_object" });
  });

  it("returns the content, the reported model and the usage counters", async () => {
    const { client } = clientWith(() => jsonResponse(COMPLETION));
    await expect(client.complete([{ role: "user", content: "hi" }])).resolves.toEqual({
      content: '{"sections":[]}',
      promptTokens: 1200,
      completionTokens: 150,
      finishReason: "stop",
      model: "vendor/model-v2",
    });
  });

  it("accepts a backend that reports no usage at all", async () => {
    const { client } = clientWith(() =>
      jsonResponse({ choices: [{ message: { content: "ok" } }] }),
    );
    await expect(client.complete([{ role: "user", content: "hi" }])).resolves.toMatchObject({
      content: "ok",
      promptTokens: null,
      model: null,
    });
  });

  it("treats rate limits and 5xx as retryable", async () => {
    for (const status of [429, 500, 503]) {
      const { client } = clientWith(() => jsonResponse({ error: "later" }, status));
      await expect(client.complete([{ role: "user", content: "hi" }])).rejects.toMatchObject({
        code: "SUMMARY_UNAVAILABLE",
        retryable: true,
      });
    }
  });

  it("treats a rejected request as terminal", async () => {
    for (const status of [400, 401, 404, 413]) {
      const { client } = clientWith(() => jsonResponse({ error: "no" }, status));
      await expect(client.complete([{ role: "user", content: "hi" }])).rejects.toMatchObject({
        code: "SUMMARY_REJECTED",
        retryable: false,
      });
    }
  });

  it("treats a transport failure as retryable", async () => {
    const { client } = clientWith(() => {
      throw new Error("ECONNREFUSED");
    });
    await expect(client.complete([{ role: "user", content: "hi" }])).rejects.toMatchObject({
      code: "SUMMARY_UNAVAILABLE",
      retryable: true,
    });
  });

  it("rejects a response that is not a chat completion", async () => {
    const { client } = clientWith(() => jsonResponse({ result: "surprise" }));
    await expect(client.complete([{ role: "user", content: "hi" }])).rejects.toMatchObject({
      code: "SUMMARY_RESPONSE_INVALID",
      retryable: false,
    });
  });

  it("rejects an empty message instead of parsing nothing later", async () => {
    const { client } = clientWith(() =>
      jsonResponse({ choices: [{ message: { content: "  " } }] }),
    );
    await expect(client.complete([{ role: "user", content: "hi" }])).rejects.toMatchObject({
      code: "SUMMARY_RESPONSE_INVALID",
    });
  });
});

describe("summary error taxonomy", () => {
  it("splits transient from terminal the way the queue needs", () => {
    expect(summaryErrorCodeForHttpStatus(429)).toEqual({
      code: "SUMMARY_UNAVAILABLE",
      retryable: true,
    });
    expect(summaryErrorCodeForHttpStatus(401)).toEqual({
      code: "SUMMARY_REJECTED",
      retryable: false,
    });
  });
});
