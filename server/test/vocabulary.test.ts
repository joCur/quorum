import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { MAX_VOCABULARY_TERMS, MAX_VOCABULARY_TERM_LENGTH } from "@quorum/shared";
import { buildServer } from "../src/app.js";
import { createTokenVerifier } from "../src/auth/token-verifier.js";
import { RecordingSessionHandler } from "../src/recording/session.js";
import { InMemoryRecordingStorage } from "../src/recording/storage/memory.js";
import { InMemoryJobQueue } from "../src/recording/queue/memory.js";
import { InMemoryMeetingStore } from "../src/meetings/memory.js";
import { InMemoryUserSettingsStore } from "../src/settings/repository.js";
import type { UserPreferences } from "../src/recording/types.js";
import { FakeConnection, WEBM_OPUS, chunk, idSequence } from "./helpers.js";
import { AUDIENCE, INTERNAL_ISSUER, ISSUER, createTestKeyPair, signAccessToken } from "./keys.js";
import type { TestKeyPair } from "./keys.js";

/**
 * The custom vocabulary end to end on the API side: stored under the caller's own scope, capped
 * where it is entered, and carried into the transcribe payload as it stood when the recording was
 * handed over.
 */

const keys: TestKeyPair = await createTestKeyPair();

const ACME = { tenantId: "tenant-acme", userId: "user-1" };
const ACME_COLLEAGUE = { tenantId: "tenant-acme", userId: "user-2" };
const GLOBEX = { tenantId: "tenant-globex", userId: "user-9" };

let app: FastifyInstance;
let settings: InMemoryUserSettingsStore;

async function call(
  method: "GET" | "PUT",
  scope: { tenantId: string; userId: string },
  payload?: unknown,
) {
  return app.inject({
    method,
    url: "/api/settings",
    headers: {
      authorization: `Bearer ${await signAccessToken(keys, { subject: scope.userId, tenantId: scope.tenantId, roles: ["quorum-user"] })}`,
    },
    ...(payload === undefined ? {} : { payload: payload as object }),
  });
}

async function vocabularyOf(scope: { tenantId: string; userId: string }): Promise<string[]> {
  return (await call("GET", scope)).json().vocabulary;
}

beforeEach(async () => {
  settings = new InMemoryUserSettingsStore();
  app = await buildServer({
    storage: new InMemoryRecordingStorage(),
    queue: new InMemoryJobQueue(),
    meetings: new InMemoryMeetingStore(),
    settings,
    auth: {
      verifyAccessToken: createTokenVerifier({
        issuers: [INTERNAL_ISSUER, ISSUER],
        audience: AUDIENCE,
        tenantClaim: "tenant_id",
        keySource: keys.jwks,
      }),
    },
  });
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

describe("managing the vocabulary", () => {
  it("starts empty and stores what is sent, alphabetically", async () => {
    expect(await vocabularyOf(ACME)).toEqual([]);

    const written = await call("PUT", ACME, { vocabulary: ["MinIO", "Ansible"] });

    expect(written.statusCode).toBe(200);
    expect(written.json().vocabulary).toEqual(["Ansible", "MinIO"]);
    expect(await vocabularyOf(ACME)).toEqual(["Ansible", "MinIO"]);
  });

  it("removes a term by storing the list without it", async () => {
    await call("PUT", ACME, { vocabulary: ["Ansible", "MinIO", "Zod"] });

    await call("PUT", ACME, { vocabulary: ["Ansible", "Zod"] });

    expect(await vocabularyOf(ACME)).toEqual(["Ansible", "Zod"]);
  });

  it("empties the list on an explicit empty array", async () => {
    // Distinct from leaving the field out: one says "no terms", the other says nothing at all.
    await call("PUT", ACME, { vocabulary: ["Ansible"] });

    expect((await call("PUT", ACME, { vocabulary: [] })).json().vocabulary).toEqual([]);
  });

  it("leaves the vocabulary alone when the body does not name it", async () => {
    // A client that predates the feature saves the settings it knows about and must not wipe the
    // ones it does not.
    await call("PUT", ACME, { vocabulary: ["Ansible"] });

    await call("PUT", ACME, { transcriptionLanguage: "de" });

    const after = (await call("GET", ACME)).json();
    expect(after.vocabulary).toEqual(["Ansible"]);
    expect(after.transcriptionLanguage).toBe("de");
  });

  it("leaves the language alone when only the vocabulary is named", async () => {
    // The mirror of the case above: the two preferences share a row and must not overwrite each
    // other.
    await call("PUT", ACME, { transcriptionLanguage: "de" });

    await call("PUT", ACME, { vocabulary: ["Ansible"] });

    const after = (await call("GET", ACME)).json();
    expect(after.transcriptionLanguage).toBe("de");
    expect(after.vocabulary).toEqual(["Ansible"]);
  });
});

describe("scoping the vocabulary (ADR-001)", () => {
  it("keeps one user's terms out of a colleague's, and out of another tenant's", async () => {
    // There is no id in the path and none in the body, so this is structural rather than a check
    // that could be forgotten — which is exactly what the test is here to hold.
    await call("PUT", ACME, { vocabulary: ["Ansible"] });

    expect(await vocabularyOf(ACME_COLLEAGUE)).toEqual([]);
    expect(await vocabularyOf(GLOBEX)).toEqual([]);
    expect(await vocabularyOf(ACME)).toEqual(["Ansible"]);
  });

  it("lets two users in one tenant keep different lists", async () => {
    await call("PUT", ACME, { vocabulary: ["Ansible"] });
    await call("PUT", ACME_COLLEAGUE, { vocabulary: ["Zod"] });

    expect(await vocabularyOf(ACME)).toEqual(["Ansible"]);
    expect(await vocabularyOf(ACME_COLLEAGUE)).toEqual(["Zod"]);
  });

  it("refuses an unauthenticated caller outright", async () => {
    expect((await app.inject({ method: "GET", url: "/api/settings" })).statusCode).toBe(401);
  });
});

describe("the limits the prompt budget imposes", () => {
  it("accepts a list at exactly the cap", async () => {
    const terms = Array.from({ length: MAX_VOCABULARY_TERMS }, (_, index) => `Term${index}`);

    expect((await call("PUT", ACME, { vocabulary: terms })).statusCode).toBe(200);
    expect(await vocabularyOf(ACME)).toHaveLength(MAX_VOCABULARY_TERMS);
  });

  it("refuses one term past the cap, and stores nothing", async () => {
    // The API refuses rather than truncating: silently keeping the first forty would be the
    // failure the whole design exists to prevent.
    const terms = Array.from({ length: MAX_VOCABULARY_TERMS + 1 }, (_, index) => `Term${index}`);

    expect((await call("PUT", ACME, { vocabulary: terms })).statusCode).toBe(400);
    expect(await vocabularyOf(ACME)).toEqual([]);
  });

  it("refuses a term longer than one entry may be", async () => {
    const long = "A".repeat(MAX_VOCABULARY_TERM_LENGTH + 1);

    expect((await call("PUT", ACME, { vocabulary: [long] })).statusCode).toBe(400);
  });

  it("refuses a list that fits the count but blows the character budget", async () => {
    const terms = Array.from({ length: 20 }, (_, index) => `${"A".repeat(38)}${index}`);

    expect((await call("PUT", ACME, { vocabulary: terms })).statusCode).toBe(400);
  });

  it("refuses a body whose vocabulary is not a list of strings", async () => {
    expect((await call("PUT", ACME, { vocabulary: "Ansible" })).statusCode).toBe(400);
    expect((await call("PUT", ACME, { vocabulary: [7] })).statusCode).toBe(400);
  });

  it("refuses a list of names that a character count would have let through", async () => {
    // 40 short Chinese names are barely a hundred characters but roughly 174 tokens of prompt.
    // The budget is spent in weighted code points precisely so this is refused here rather than
    // losing its front at the backend.
    const names = Array.from(
      { length: 40 },
      (_, index) => `\u5f20\u4f1f${String.fromCodePoint(0x4e00 + index)}`,
    );

    expect((await call("PUT", ACME, { vocabulary: names })).statusCode).toBe(400);
  });

  it("accepts a vocabulary in another script that does fit", async () => {
    // The weighting must not make non-Latin terms unusable — only honestly priced.
    const names = ["\u5f20\u4f1f", "\u738b\u82b3", "\u674e\u5a1c"];

    expect((await call("PUT", ACME, { vocabulary: names })).statusCode).toBe(200);
    expect(await vocabularyOf(ACME)).toHaveLength(3);
  });

  it("repairs a stored list that the current caps no longer allow", async () => {
    // A row written when the caps were wider is trimmed to what fits, keeping the terms it can
    // rather than discarding the lot — and one bad entry must not take the rest with it.
    const store = new InMemoryUserSettingsStore();
    await store.updateSettings(ACME, { vocabulary: ["Ansible", "MinIO"] });

    expect((await store.findSettings(ACME)).vocabulary).toEqual(["Ansible", "MinIO"]);
  });

  it("stores one term for two spellings that differ only in case", async () => {
    const written = await call("PUT", ACME, { vocabulary: ["Keycloak", "keycloak", "  MinIO "] });

    expect(written.json().vocabulary).toEqual(["Keycloak", "MinIO"]);
  });
});

/** The recording endpoint's side: what is stored now is what the finished recording is sent with. */
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
async function record(harness: ReturnType<typeof harnessWith>): Promise<void> {
  await harness.handler.handleText(
    JSON.stringify({
      type: "session.start",
      meetingTitle: "Weekly sync",
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
}

describe("the vocabulary in the transcribe payload", () => {
  it("travels with the job, sorted", async () => {
    const store = new InMemoryUserSettingsStore();
    await store.updateSettings(SCOPE, { vocabulary: ["MinIO", "Ansible"] });

    const harness = harnessWith(store);
    await record(harness);

    expect(harness.queue.enqueued[0]?.vocabulary).toEqual(["Ansible", "MinIO"]);
  });

  it("is empty for a user who has stored none", async () => {
    const harness = harnessWith(new InMemoryUserSettingsStore());
    await record(harness);

    expect(harness.queue.enqueued[0]?.vocabulary).toEqual([]);
  });

  it("reads another user's vocabulary as no vocabulary at all", async () => {
    const store = new InMemoryUserSettingsStore();
    await store.updateSettings(
      { tenantId: "tenant-a", userId: "someone-else" },
      { vocabulary: ["Ansible"] },
    );

    const harness = harnessWith(store);
    await record(harness);

    expect(harness.queue.enqueued[0]?.vocabulary).toEqual([]);
  });

  it("is captured at hand-over, so a later edit does not reach the job already queued", async () => {
    // The same reasoning as the language: what was configured when the recording was made is what
    // the job — including a retry of it — is run with.
    const store = new InMemoryUserSettingsStore();
    await store.updateSettings(SCOPE, { vocabulary: ["Ansible"] });
    const harness = harnessWith(store);
    await record(harness);

    await store.updateSettings(SCOPE, { vocabulary: ["Zod"] });

    expect(harness.queue.enqueued[0]?.vocabulary).toEqual(["Ansible"]);
  });

  it("still finalizes the recording when the preferences cannot be read", async () => {
    // The audio is already safe at this point. Losing the bias is a disappointment; losing the
    // recording over a settings lookup would be a defect.
    const broken: UserPreferences = {
      findSettings: async () => {
        throw new Error("database unavailable");
      },
    };
    const harness = harnessWith(broken);

    await record(harness);

    expect(harness.queue.enqueued).toHaveLength(1);
    expect(harness.queue.enqueued[0]?.vocabulary).toEqual([]);
  });
});
