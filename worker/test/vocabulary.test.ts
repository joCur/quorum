import { describe, expect, it } from "vitest";
import { MAX_VOCABULARY_TERMS } from "@quorum/shared";
import { runTranscribeJob } from "../src/handler.js";
import { parseTranscribeJobPayload } from "../src/payload.js";
import { OpenAiTranscriptionClient } from "../src/whisper/client.js";
import {
  FakeAudioSource,
  FakeTranscriptionClient,
  InMemoryRepository,
  VERBOSE_RESPONSE_WITH_WORDS,
  silentLogger,
  transcribeJob,
  transcribePayload,
} from "./helpers.js";

/**
 * The worker's half of the custom vocabulary: the terms arrive in the payload, already normalized
 * and capped by the side that stored them, and become the transcription request's `prompt`.
 */
function deps(overrides: Partial<Parameters<typeof runTranscribeJob>[2]> = {}) {
  return {
    audio: new FakeAudioSource(),
    transcription: new FakeTranscriptionClient(),
    repository: new InMemoryRepository(),
    logger: silentLogger,
    ...overrides,
  };
}

describe("the vocabulary a transcription is biased with", () => {
  it("sends the payload's terms as the prompt, alphabetically", async () => {
    const client = new FakeTranscriptionClient();
    await runTranscribeJob(
      transcribePayload({ vocabulary: ["MinIO", "Ansible", "Keycloak"] }),
      0,
      deps({ transcription: client }),
    );

    expect(client.requests[0]?.prompt).toBe("Ansible, Keycloak, MinIO.");
  });

  it("sends no prompt at all for a user with no terms", async () => {
    // A recording from a user who has added nothing must produce exactly the request the backend
    // saw before this feature existed.
    const client = new FakeTranscriptionClient();
    await runTranscribeJob(
      transcribePayload({ vocabulary: [] }),
      0,
      deps({ transcription: client }),
    );

    expect(client.requests[0]?.prompt).toBeUndefined();
  });

  it("carries the vocabulary independently of the language", async () => {
    // The two preferences are resolved by different chains and must not be entangled: asking for
    // detection does not mean asking for no bias.
    const client = new FakeTranscriptionClient();
    await runTranscribeJob(
      transcribePayload({ language: null, vocabulary: ["Quorum"] }),
      0,
      deps({ transcription: client }),
    );

    expect(client.requests[0]?.language).toBeUndefined();
    expect(client.requests[0]?.prompt).toBe("Quorum.");
  });
});

describe("the transcribe payload", () => {
  it("reads a job enqueued before the vocabulary existed as an empty list", async () => {
    // Deploys are not atomic: jobs sitting on the queue when the worker restarts carry no
    // `vocabulary` field, and they have to keep running rather than dead-letter on a parse.
    const legacy = {
      job: transcribeJob(),
      tenantId: "acme",
      userId: "user-1",
      sessionId: "33333333-3333-4333-8333-333333333333",
    };

    expect(parseTranscribeJobPayload(legacy).vocabulary).toEqual([]);
  });

  it("carries the terms through unchanged", () => {
    const parsed = parseTranscribeJobPayload({
      ...transcribePayload(),
      vocabulary: ["Ansible", "MinIO"],
    });

    expect(parsed.vocabulary).toEqual(["Ansible", "MinIO"]);
  });
});

describe("the prompt on the wire", () => {
  it("posts the vocabulary as the OpenAI-compatible `prompt` field", async () => {
    let form: FormData | null = null;
    await new OpenAiTranscriptionClient({
      baseUrl: "http://whisper:8000/v1",
      model: "small",
      fetchImpl: async (_url, init) => {
        form = init?.body as FormData;
        return new Response(JSON.stringify(VERBOSE_RESPONSE_WITH_WORDS), {
          headers: { "content-type": "application/json" },
        });
      },
    }).transcribe({
      audio: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
      filename: "recording.webm",
      contentType: "audio/webm",
      prompt: "Ansible, MinIO.",
    });

    expect(form!.get("prompt")).toBe("Ansible, MinIO.");
  });

  it("omits the field entirely when there is nothing to bias towards", async () => {
    let form: FormData | null = null;
    await new OpenAiTranscriptionClient({
      baseUrl: "http://whisper:8000/v1",
      model: "small",
      fetchImpl: async (_url, init) => {
        form = init?.body as FormData;
        return new Response(JSON.stringify(VERBOSE_RESPONSE_WITH_WORDS), {
          headers: { "content-type": "application/json" },
        });
      },
    }).transcribe({
      audio: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]),
      filename: "recording.webm",
      contentType: "audio/webm",
    });

    expect(form!.get("prompt")).toBeNull();
  });

  it("sends a full-sized vocabulary whole, because the backend would silently trim it", async () => {
    // faster-whisper keeps only the tail of an over-long prompt and says nothing. The caps exist
    // so that never happens; this holds the assembled worst case to what the backend will keep.
    const terms = Array.from({ length: MAX_VOCABULARY_TERMS }, (_, index) => `Term${index}`);
    const client = new FakeTranscriptionClient();
    await runTranscribeJob(
      transcribePayload({ vocabulary: terms }),
      0,
      deps({ transcription: client }),
    );

    const prompt = client.requests[0]?.prompt as string;
    for (const term of terms) expect(prompt).toContain(term);
  });
});
