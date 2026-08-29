import { describe, expect, it } from "vitest";
import { errorCodeForHttpStatus, toJobError, JobError } from "../src/errors.js";
import { OpenAiTranscriptionClient } from "../src/whisper/client.js";
import { VERBOSE_RESPONSE_WITH_WORDS } from "./helpers.js";

function client(fetchImpl: typeof fetch, apiKey?: string): OpenAiTranscriptionClient {
  return new OpenAiTranscriptionClient({
    baseUrl: "http://whisper:8000/v1/",
    model: "small",
    fetchImpl,
    ...(apiKey ? { apiKey } : {}),
  });
}

const audio = {
  audio: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
  filename: "recording.webm",
  contentType: "audio/webm",
};

describe("OpenAI-compatible transcription client", () => {
  it("posts multipart audio and asks for word and segment timestamps", async () => {
    let seen: { url: string; form: FormData } | null = null;
    const response = await client(async (url, init) => {
      seen = { url: String(url), form: init?.body as FormData };
      return new Response(JSON.stringify(VERBOSE_RESPONSE_WITH_WORDS), {
        headers: { "content-type": "application/json" },
      });
    }).transcribe({ ...audio, language: "de" });

    expect(seen!.url).toBe("http://whisper:8000/v1/audio/transcriptions");
    const form = seen!.form;
    expect(form.get("model")).toBe("small");
    expect(form.get("response_format")).toBe("verbose_json");
    expect(form.getAll("timestamp_granularities[]")).toEqual(["segment", "word"]);
    expect(form.get("language")).toBe("de");
    expect((form.get("file") as File).name).toBe("recording.webm");
    expect(response.segments?.[0]?.words).toHaveLength(3);
  });

  it("omits the language when none is configured, letting the backend detect it", async () => {
    let form: FormData | null = null;
    await client(async (_url, init) => {
      form = init?.body as FormData;
      return Response.json(VERBOSE_RESPONSE_WITH_WORDS);
    }).transcribe(audio);
    expect(form!.get("language")).toBeNull();
  });

  it("sends a bearer token only when one is configured", async () => {
    let headers: Record<string, string> | undefined;
    await client(async (_url, init) => {
      headers = init?.headers as Record<string, string> | undefined;
      return Response.json(VERBOSE_RESPONSE_WITH_WORDS);
    }, "secret").transcribe(audio);
    expect(headers).toMatchObject({ authorization: "Bearer secret" });
  });

  it("treats a connection failure as retryable", async () => {
    await expect(
      client(async () => {
        throw new Error("connect ECONNREFUSED");
      }).transcribe(audio),
    ).rejects.toMatchObject({ code: "TRANSCRIPTION_UNAVAILABLE", retryable: true });
  });

  it("treats a rejected audio file as terminal", async () => {
    await expect(
      client(async () => new Response("cannot decode", { status: 400 })).transcribe(audio),
    ).rejects.toMatchObject({ code: "AUDIO_DECODE_FAILED", retryable: false });
  });

  it("treats a backend outage as retryable", async () => {
    await expect(
      client(async () => new Response("busy", { status: 503 })).transcribe(audio),
    ).rejects.toMatchObject({ code: "TRANSCRIPTION_UNAVAILABLE", retryable: true });
  });

  it("rejects a response that is not in the OpenAI-compatible shape", async () => {
    await expect(
      client(async () => Response.json({ segments: [{ start: "soon" }] })).transcribe(audio),
    ).rejects.toMatchObject({ code: "TRANSCRIPTION_RESPONSE_INVALID", retryable: false });
  });

  it("rejects a non-JSON body", async () => {
    await expect(
      client(async () => new Response("<html>gateway</html>", { status: 200 })).transcribe(audio),
    ).rejects.toMatchObject({ code: "TRANSCRIPTION_RESPONSE_INVALID" });
  });
});

describe("error mapping", () => {
  it.each([
    [400, "AUDIO_DECODE_FAILED", false],
    [415, "AUDIO_DECODE_FAILED", false],
    [422, "AUDIO_DECODE_FAILED", false],
    [401, "TRANSCRIPTION_REJECTED", false],
    [404, "TRANSCRIPTION_REJECTED", false],
    [408, "TRANSCRIPTION_UNAVAILABLE", true],
    [429, "TRANSCRIPTION_UNAVAILABLE", true],
    [500, "TRANSCRIPTION_UNAVAILABLE", true],
    [502, "TRANSCRIPTION_UNAVAILABLE", true],
  ])("maps HTTP %i", (status, code, retryable) => {
    expect(errorCodeForHttpStatus(status)).toEqual({ code, retryable });
  });

  it("passes a JobError through untouched", () => {
    const original = new JobError("AUDIO_EMPTY", "nothing", { retryable: false });
    expect(toJobError(original)).toBe(original);
  });

  it("wraps anything else as a retryable internal error", () => {
    expect(toJobError("boom")).toMatchObject({
      code: "INTERNAL_ERROR",
      retryable: true,
      message: "boom",
    });
  });
});
