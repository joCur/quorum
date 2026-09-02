import { describe, expect, it } from "vitest";
import { sessionKey } from "../src/recording/keys.js";
import { RecordingSessionHandler } from "../src/recording/session.js";
import { InMemoryRecordingStorage } from "../src/recording/storage/memory.js";
import { InMemoryJobQueue } from "../src/recording/queue/memory.js";
import { InMemoryUserSettingsStore } from "../src/settings/repository.js";
import type { UserPreferences } from "../src/recording/types.js";
import { FakeConnection, WEBM_OPUS, chunk, idSequence } from "./helpers.js";

/**
 * The API's half of the transcription language chain: the choice made for the meeting, then the
 * user's stored default. What is resolved here travels in the job payload, so a retry an hour
 * later transcribes what was asked for at the time.
 */

const SCOPE = { tenantId: "tenant-a", userId: "user-1" };

function harnessWith(preferences?: UserPreferences) {
  const connection = new FakeConnection();
  const storage = new InMemoryRecordingStorage();
  const queue = new InMemoryJobQueue();
  const handler = new RecordingSessionHandler(connection, {
    storage,
    queue,
    context: SCOPE,
    ...(preferences ? { preferences } : {}),
    newId: idSequence(),
    now: () => new Date("2026-08-29T10:00:00.000Z"),
  });
  return { connection, storage, queue, handler };
}

/** Starts, streams one chunk and finalizes — the shortest path to an enqueued transcribe job. */
async function record(
  harness: ReturnType<typeof harnessWith>,
  language: string | null,
): Promise<string> {
  await harness.handler.handleText(
    JSON.stringify({
      type: "session.start",
      meetingTitle: "Weekly sync",
      language,
      audioFormat: WEBM_OPUS,
      clientInfo: { platform: "web-desktop", userAgent: "vitest" },
    }),
  );
  const ready = harness.connection.last("session.ready");
  if (!ready) throw new Error("session.ready was not sent");
  await harness.handler.handleBinary(chunk(ready.sessionId, 0));
  await harness.handler.handleText(
    JSON.stringify({ type: "session.end", sessionId: ready.sessionId, lastSeq: 0 }),
  );
  return ready.sessionId;
}

describe("the language a meeting is recorded in", () => {
  it("is stored with the session, alongside the summary template", async () => {
    const harness = harnessWith();
    const sessionId = await record(harness, "fr");

    // Written in the same step as the rest of the session record, so the choice and the recording
    // cannot end up disagreeing about what was asked for.
    const stored = harness.storage.objects.get(sessionKey({ ...SCOPE, sessionId }));
    expect(JSON.parse(new TextDecoder().decode(stored)).language).toBe("fr");
  });

  it("travels to the pipeline in the transcribe job", async () => {
    const harness = harnessWith();
    await record(harness, "fr");

    expect(harness.queue.enqueued[0]?.language).toBe("fr");
  });

  it("falls back to the user's default when the meeting states none", async () => {
    const settings = new InMemoryUserSettingsStore();
    await settings.updateSettings(SCOPE, { transcriptionLanguage: "de" });
    const harness = harnessWith(settings);

    await record(harness, null);

    expect(harness.queue.enqueued[0]?.language).toBe("de");
  });

  it("leaves the meeting's own choice alone even when a default is stored", async () => {
    const settings = new InMemoryUserSettingsStore();
    await settings.updateSettings(SCOPE, { transcriptionLanguage: "de" });
    const harness = harnessWith(settings);

    await record(harness, "fr");

    expect(harness.queue.enqueued[0]?.language).toBe("fr");
  });

  it("reads another user's default as no default at all", async () => {
    const settings = new InMemoryUserSettingsStore();
    await settings.updateSettings(
      { tenantId: "tenant-a", userId: "someone-else" },
      {
        transcriptionLanguage: "de",
      },
    );
    const harness = harnessWith(settings);

    await record(harness, null);

    // ADR-001: a preference is read under the tenant and user the recording runs as, so a
    // neighbor's setting is invisible rather than merely unused.
    expect(harness.queue.enqueued[0]?.language).toBeNull();
  });

  it("states nothing rather than losing the recording when the preference cannot be read", async () => {
    const harness = harnessWith({
      findSettings: async () => {
        throw new Error("database unavailable");
      },
    });

    await record(harness, null);

    // The audio is already safe by this point. A meeting transcribed with one link of the chain
    // missing is worth incomparably more than a finalize that fails over a preference.
    expect(harness.connection.last("session.finalized")).toBeDefined();
    expect(harness.queue.enqueued).toHaveLength(1);
    expect(harness.queue.enqueued[0]?.language).toBeNull();
  });

  it("drops a language this build does not offer instead of shipping it to the backend", async () => {
    const harness = harnessWith();

    await record(harness, "klingon");

    // An unrecognized tag would short-circuit the chain, travel verbatim as the transcription
    // request's `language`, and then either dead-letter the job on a backend that rejects it or
    // become the transcript's language label on one that ignores it. Dropping it costs the
    // choice and keeps the recording.
    expect(harness.queue.enqueued[0]?.language).toBeNull();
    const sessionId = harness.connection.last("session.ready")?.sessionId ?? "";
    const stored = harness.storage.objects.get(sessionKey({ ...SCOPE, sessionId }));
    expect(JSON.parse(new TextDecoder().decode(stored)).language).toBeNull();
  });

  it("falls through to the user's default when the meeting's language is blank", async () => {
    const settings = new InMemoryUserSettingsStore();
    await settings.updateSettings(SCOPE, { transcriptionLanguage: "de" });
    const harness = harnessWith(settings);

    await record(harness, "  ");

    // A blank string is not a statement. Treating it as one would short-circuit the chain here
    // and then evaporate at the worker, skipping the user's default entirely.
    expect(harness.queue.enqueued[0]?.language).toBe("de");
  });

  it("still records when the language is one this build does not offer", async () => {
    const harness = harnessWith();

    await record(harness, "klingon");

    // The socket carries the audio. Refusing it over a language tag would cost the meeting, which
    // is why the protocol schema checks the shape and this checks the value.
    expect(harness.connection.last("session.finalized")).toBeDefined();
    expect(harness.connection.closed?.code).not.toBe(1008);
  });

  it("states nothing when neither the meeting nor the user chose", async () => {
    const harness = harnessWith(new InMemoryUserSettingsStore());

    await record(harness, null);

    // Not a guess and not an empty string: the remaining links belong to the worker.
    expect(harness.queue.enqueued[0]?.language).toBeNull();
  });
});

describe("the stored preference", () => {
  it("reads as unset for a user who has chosen nothing", async () => {
    const settings = new InMemoryUserSettingsStore();

    expect(await settings.findSettings(SCOPE)).toEqual({
      transcriptionLanguage: null,
      vocabulary: [],
    });
  });

  it("can be given up again", async () => {
    const settings = new InMemoryUserSettingsStore();
    await settings.updateSettings(SCOPE, { transcriptionLanguage: "de" });

    const cleared = await settings.updateSettings(SCOPE, { transcriptionLanguage: null });

    expect(cleared.transcriptionLanguage).toBeNull();
  });

  it("is left alone by an update that does not name it", async () => {
    // A client that predates a preference must not reset it by saving the ones it knows about.
    const settings = new InMemoryUserSettingsStore();
    await settings.updateSettings(SCOPE, { transcriptionLanguage: "de" });

    const untouched = await settings.updateSettings(SCOPE, {});

    expect(untouched.transcriptionLanguage).toBe("de");
  });
});
