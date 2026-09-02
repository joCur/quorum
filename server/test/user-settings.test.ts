import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/app.js";
import { createTokenVerifier } from "../src/auth/token-verifier.js";
import { InMemoryRecordingStorage } from "../src/recording/storage/memory.js";
import { InMemoryJobQueue } from "../src/recording/queue/memory.js";
import { InMemoryMeetingStore } from "../src/meetings/memory.js";
import {
  InMemoryUserSettingsStore,
  PostgresUserSettingsStore,
  UserSettingsUnavailableError,
  type UserSettingsStore,
} from "../src/settings/repository.js";
import type postgres from "postgres";
import { AUDIENCE, INTERNAL_ISSUER, ISSUER, createTestKeyPair, signAccessToken } from "./keys.js";
import type { TestKeyPair } from "./keys.js";

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

function build(store?: UserSettingsStore): Promise<FastifyInstance> {
  return buildServer({
    storage: new InMemoryRecordingStorage(),
    queue: new InMemoryJobQueue(),
    meetings: new InMemoryMeetingStore(),
    ...(store ? { settings: store } : {}),
    auth: {
      verifyAccessToken: createTokenVerifier({
        issuers: [INTERNAL_ISSUER, ISSUER],
        audience: AUDIENCE,
        tenantClaim: "tenant_id",
        keySource: keys.jwks,
      }),
    },
  });
}

// A fresh store and a fresh instance per test: these routes are about what is stored, so a
// leftover row from the test before would be the one thing that could make them lie.
beforeEach(async () => {
  settings = new InMemoryUserSettingsStore();
  app = await build(settings);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

/**
 * The preferences API. There is no id in the path and none in the body: a caller addresses their
 * own row and nothing else, which is what makes ADR-001 scoping structural here rather than a
 * check that could be forgotten.
 */
describe("the settings API", () => {
  it("answers a user who has chosen nothing with the defaults", async () => {
    const response = await call("GET", ACME);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ transcriptionLanguage: null, vocabulary: [] });
  });

  it("stores a choice and answers with what is now stored", async () => {
    const written = await call("PUT", ACME, { transcriptionLanguage: "de" });

    expect(written.statusCode).toBe(200);
    // The response is the settings rather than 204, so the screen renders what was stored instead
    // of what it hoped for.
    expect(written.json()).toEqual({ transcriptionLanguage: "de", vocabulary: [] });
    expect((await call("GET", ACME)).json()).toEqual({
      transcriptionLanguage: "de",
      vocabulary: [],
    });
  });

  it("gives the choice up again on an explicit null", async () => {
    await call("PUT", ACME, { transcriptionLanguage: "de" });

    expect((await call("PUT", ACME, { transcriptionLanguage: null })).json()).toEqual({
      transcriptionLanguage: null,
      vocabulary: [],
    });
  });

  it("leaves a preference the body does not name alone", async () => {
    await call("PUT", ACME, { transcriptionLanguage: "de" });

    // A client that predates a preference must not reset it by saving the ones it knows about.
    expect((await call("PUT", ACME, {})).json()).toEqual({
      transcriptionLanguage: "de",
      vocabulary: [],
    });
  });

  it("refuses a language the pickers do not offer", async () => {
    const response = await call("PUT", ACME, { transcriptionLanguage: "klingon" });

    // The value ends up as the `language` field of a transcription request; a backend answers a
    // tag it cannot read with a rejection rather than with a transcript.
    expect(response.statusCode).toBe(400);
    expect((await call("GET", ACME)).json()).toEqual({
      transcriptionLanguage: null,
      vocabulary: [],
    });
  });

  it("keeps one user's preferences out of another's, inside a tenant and across tenants", async () => {
    await call("PUT", ACME, { transcriptionLanguage: "de" });

    expect((await call("GET", ACME_COLLEAGUE)).json()).toEqual({
      transcriptionLanguage: null,
      vocabulary: [],
    });
    expect((await call("GET", GLOBEX)).json()).toEqual({
      transcriptionLanguage: null,
      vocabulary: [],
    });
  });

  it("refuses a request without a token", async () => {
    const response = await app.inject({ method: "GET", url: "/api/settings" });

    expect(response.statusCode).toBe(401);
  });
});

describe("an instance built without a settings store", () => {
  it("does not serve the settings API at all", async () => {
    // Same rule the template API follows: the route exists where there is something behind it,
    // rather than existing and answering "not configured".
    const bare = await build();
    await bare.ready();

    try {
      const response = await bare.inject({
        method: "GET",
        url: "/api/settings",
        headers: {
          authorization: `Bearer ${await signAccessToken(keys, { subject: ACME.userId, tenantId: ACME.tenantId, roles: ["quorum-user"] })}`,
        },
      });
      expect(response.statusCode).toBe(404);
    } finally {
      await bare.close();
    }
  });
});

/**
 * The two states in which the schema cannot hold the preference, both of which happen during a
 * normal deploy rather than only in a broken stack.
 *
 * `undefined_column` is the one worth the fixture: `user_settings` already exists wherever the
 * default summary template was ever used, so between the API rolling out and the worker restarting
 * with the new migration list, the table is there and the column is not.
 */
function raisingSql(code: string): postgres.Sql {
  return (() => {
    throw Object.assign(new Error(`simulated ${code}`), { code });
  }) as unknown as postgres.Sql;
}

describe.each([
  ["a table the worker has never created", "42P01"],
  ["a table that predates the column", "42703"],
])("reading preferences against %s", (_name, code) => {
  it("reads as nothing chosen rather than failing", async () => {
    const store = new PostgresUserSettingsStore(raisingSql(code));

    // The settings screen and, more importantly, the recording endpoint both ask this. Neither
    // can afford to fail over a preference that simply is not stored yet — the chain has further
    // links, and a recording must not be lost to a mid-deploy read.
    expect(await store.findSettings(ACME)).toEqual({ transcriptionLanguage: null, vocabulary: [] });
  });

  it("refuses a write instead of reporting a success that never happened", async () => {
    const store = new PostgresUserSettingsStore(raisingSql(code));

    // A read has a truthful answer in this state; a write does not. Claiming the choice was saved
    // would leave the screen showing a value the next reload silently drops.
    await expect(
      store.updateSettings(ACME, { transcriptionLanguage: "de" }),
    ).rejects.toBeInstanceOf(UserSettingsUnavailableError);
  });

  it("answers a save with 503 and a structured body, not a bare 500", async () => {
    const unready = await build(new PostgresUserSettingsStore(raisingSql(code)));
    await unready.ready();

    try {
      const response = await unready.inject({
        method: "PUT",
        url: "/api/settings",
        headers: {
          authorization: `Bearer ${await signAccessToken(keys, { subject: ACME.userId, tenantId: ACME.tenantId, roles: ["quorum-user"] })}`,
        },
        payload: { transcriptionLanguage: "de" },
      });

      // Nothing is wrong with the request, and it will succeed once the worker has come up.
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ error: "settings_unavailable" });
    } finally {
      await unready.close();
    }
  });
});

describe("a database error that is not a missing schema", () => {
  it("is not swallowed by either half of the store", async () => {
    // The grace is for two specific, expected states. A connection failure or a syntax error must
    // still surface rather than being reported to the user as "you have chosen nothing".
    const store = new PostgresUserSettingsStore(raisingSql("08006"));

    await expect(store.findSettings(ACME)).rejects.toThrow("simulated 08006");
    await expect(store.updateSettings(ACME, { transcriptionLanguage: "de" })).rejects.toThrow(
      "simulated 08006",
    );
  });
});
