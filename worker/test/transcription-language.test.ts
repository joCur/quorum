import { describe, expect, it } from "vitest";
import { runTranscribeJob } from "../src/handler.js";
import { parseTranscribeJobPayload } from "../src/payload.js";
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
 * The worker's half of the language chain: what the API resolved for this meeting, then this
 * deployment's `WHISPER_LANGUAGE`, then detection. The links above these two are decided before
 * the job is enqueued and arrive in the payload.
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

describe("the language a transcription is requested in", () => {
  it("asks for what the job payload carries", async () => {
    const client = new FakeTranscriptionClient();
    await runTranscribeJob(
      transcribePayload({ language: "fr" }),
      0,
      deps({ transcription: client, language: "de" }),
    );

    // The meeting's own language beats the deployment default; the whole point of the feature is
    // that a single stack can serve a meeting held in another language.
    expect(client.requests[0]?.language).toBe("fr");
  });

  it("falls back to the deployment default when the payload states nothing", async () => {
    const client = new FakeTranscriptionClient();
    await runTranscribeJob(
      transcribePayload({ language: null }),
      0,
      deps({ transcription: client, language: "de" }),
    );

    expect(client.requests[0]?.language).toBe("de");
  });

  it("sends no language at all when nothing is configured either", async () => {
    const client = new FakeTranscriptionClient();
    await runTranscribeJob(
      transcribePayload({ language: null }),
      0,
      deps({ transcription: client }),
    );

    // Not the empty string: the field is left off the request entirely, which is what makes the
    // backend detect the language instead of being handed a tag it cannot read.
    expect(client.requests[0]?.language).toBeUndefined();
  });

  it("honors an explicit request for detection over the deployment default", async () => {
    const client = new FakeTranscriptionClient();
    await runTranscribeJob(
      transcribePayload({ language: "auto" }),
      0,
      deps({ transcription: client, language: "de" }),
    );

    expect(client.requests[0]?.language).toBeUndefined();
  });

  it("labels the transcript with what was asked for when the backend reports nothing", async () => {
    // A meeting we deliberately transcribed as German must not come back saying "undetermined":
    // the meeting list shows this value as the meeting's language.
    const client = new FakeTranscriptionClient("small", {
      ...VERBOSE_RESPONSE_WITH_WORDS,
      language: undefined,
    });
    const dependencies = deps({ transcription: client });
    const outcome = await runTranscribeJob(transcribePayload({ language: "de" }), 0, dependencies);

    const repository = dependencies.repository as InMemoryRepository;
    expect(repository.transcripts.get(outcome.transcriptId)?.transcript.language).toBe("de");
  });

  it("keeps the language the backend detected when it reports one", async () => {
    const dependencies = deps();
    const outcome = await runTranscribeJob(transcribePayload({ language: "de" }), 0, dependencies);

    // What the meeting says it is in has to be what the transcript actually is, and only the
    // backend can say what came out — the request is a hint, not a promise.
    const repository = dependencies.repository as InMemoryRepository;
    expect(repository.transcripts.get(outcome.transcriptId)?.transcript.language).toBe("en");
  });

  it("reads a job enqueued before the field existed as stating no language", async () => {
    // Jobs sit on the queue across a deploy; one without the field must not be dead-lettered.
    const payload = parseTranscribeJobPayload({
      job: transcribeJob(),
      tenantId: "tenant-a",
      userId: "user-1",
      sessionId: "11111111-1111-4111-8111-111111111111",
    });

    expect(payload.language).toBeNull();
  });
});
