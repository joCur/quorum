import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/app.js";
import { createTokenVerifier } from "../src/auth/token-verifier.js";
import { InMemoryRecordingStorage } from "../src/recording/storage/memory.js";
import { InMemoryJobQueue } from "../src/recording/queue/memory.js";
import { InMemoryMeetingStore } from "../src/meetings/memory.js";
import { InMemoryUserSettingsStore } from "../src/settings/repository.js";
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

function build(store?: InMemoryUserSettingsStore): Promise<FastifyInstance> {
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
    expect(response.json()).toEqual({ transcriptionLanguage: null });
  });

  it("stores a choice and answers with what is now stored", async () => {
    const written = await call("PUT", ACME, { transcriptionLanguage: "de" });

    expect(written.statusCode).toBe(200);
    // The response is the settings rather than 204, so the screen renders what was stored instead
    // of what it hoped for.
    expect(written.json()).toEqual({ transcriptionLanguage: "de" });
    expect((await call("GET", ACME)).json()).toEqual({ transcriptionLanguage: "de" });
  });

  it("gives the choice up again on an explicit null", async () => {
    await call("PUT", ACME, { transcriptionLanguage: "de" });

    expect((await call("PUT", ACME, { transcriptionLanguage: null })).json()).toEqual({
      transcriptionLanguage: null,
    });
  });

  it("leaves a preference the body does not name alone", async () => {
    await call("PUT", ACME, { transcriptionLanguage: "de" });

    // A client that predates a preference must not reset it by saving the ones it knows about.
    expect((await call("PUT", ACME, {})).json()).toEqual({ transcriptionLanguage: "de" });
  });

  it("refuses a language the pickers do not offer", async () => {
    const response = await call("PUT", ACME, { transcriptionLanguage: "klingon" });

    // The value ends up as the `language` field of a transcription request; a backend answers a
    // tag it cannot read with a rejection rather than with a transcript.
    expect(response.statusCode).toBe(400);
    expect((await call("GET", ACME)).json()).toEqual({ transcriptionLanguage: null });
  });

  it("keeps one user's preferences out of another's, inside a tenant and across tenants", async () => {
    await call("PUT", ACME, { transcriptionLanguage: "de" });

    expect((await call("GET", ACME_COLLEAGUE)).json()).toEqual({ transcriptionLanguage: null });
    expect((await call("GET", GLOBEX)).json()).toEqual({ transcriptionLanguage: null });
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
