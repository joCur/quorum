import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/app.js";
import { DEFAULT_USER_LIMITS, type UserLimits, type UserLimitsResolver } from "../src/limits.js";
import { InMemoryRecordingStorage } from "../src/recording/storage/memory.js";
import { InMemoryJobQueue } from "../src/recording/queue/memory.js";
import { InMemoryMeetingStore } from "../src/meetings/memory.js";
import { InMemorySummaryTemplateStore } from "../src/templates/memory.js";
import { createTokenVerifier } from "../src/auth/token-verifier.js";
import {
  AUDIENCE,
  INTERNAL_ISSUER,
  ISSUER,
  createTestKeyPair,
  signAccessToken,
  type TestKeyPair,
} from "./keys.js";

let keys: TestKeyPair | null = null;

async function keyPair(): Promise<TestKeyPair> {
  keys ??= await createTestKeyPair();
  return keys;
}

async function signedToken(subject: string): Promise<string> {
  return signAccessToken(await keyPair(), { subject, tenantId: "tenant-acme" });
}

let app: FastifyInstance | null = null;

afterEach(async () => {
  await app?.close();
  app = null;
});

async function build(limits: UserLimits): Promise<FastifyInstance> {
  const resolver: UserLimitsResolver = { resolve: async () => limits };
  app = await buildServer({
    storage: new InMemoryRecordingStorage(),
    queue: new InMemoryJobQueue(),
    meetings: new InMemoryMeetingStore(),
    templates: new InMemorySummaryTemplateStore(),
    auth: {
      verifyAccessToken: createTokenVerifier({
        issuers: [INTERNAL_ISSUER, ISSUER],
        audience: AUDIENCE,
        tenantClaim: "tenant_id",
        keySource: (await keyPair()).jwks,
      }),
    },
    limits: resolver,
  });
  await app.ready();
  return app;
}

async function get(instance: FastifyInstance, token: string, url = "/api/meetings") {
  return instance.inject({ method: "GET", url, headers: { authorization: `Bearer ${token}` } });
}

describe("per-user REST rate limit", () => {
  it("serves requests up to the limit and refuses the one past it", async () => {
    const instance = await build({ ...DEFAULT_USER_LIMITS, apiRequestsPerWindow: 3 });
    const token = await signedToken("11111111-1111-4111-8111-111111111111");

    for (let request = 0; request < 3; request += 1) {
      expect((await get(instance, token)).statusCode).toBe(200);
    }

    const refused = await get(instance, token);
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toMatchObject({ error: "limit.request_rate_exceeded" });
  });

  it("gives every user their own allowance", async () => {
    const instance = await build({ ...DEFAULT_USER_LIMITS, apiRequestsPerWindow: 2 });
    const mine = await signedToken("11111111-1111-4111-8111-111111111111");
    const yours = await signedToken("22222222-2222-4222-8222-222222222222");

    await get(instance, mine);
    await get(instance, mine);
    expect((await get(instance, mine)).statusCode).toBe(429);
    // A second user is not behind the first one's spending, even from the same address.
    expect((await get(instance, yours)).statusCode).toBe(200);
  });

  it("does not throttle the health probe", async () => {
    const instance = await build({ ...DEFAULT_USER_LIMITS, apiRequestsPerWindow: 1 });
    for (let request = 0; request < 5; request += 1) {
      const response = await instance.inject({ method: "GET", url: "/healthz" });
      expect(response.statusCode).toBe(200);
    }
  });

  it("meters the regenerate route against the smaller summary allowance", async () => {
    const instance = await build({
      ...DEFAULT_USER_LIMITS,
      apiRequestsPerWindow: 100,
      apiSummaryRequestsPerWindow: 1,
    });
    const token = await signedToken("11111111-1111-4111-8111-111111111111");
    const url = "/api/meetings/1a3b8c5d-0000-4000-8000-000000000001/summaries";
    const body = { headers: { authorization: `Bearer ${token}` } };

    // The meeting does not exist, so both requests are 404s — what matters is that the second one
    // is refused by the limiter rather than reaching the handler.
    const first = await instance.inject({ method: "POST", url, ...body });
    expect(first.statusCode).toBe(404);
    const second = await instance.inject({ method: "POST", url, ...body });
    expect(second.statusCode).toBe(429);

    // The general allowance is untouched by the expensive route's own budget.
    expect((await get(instance, token)).statusCode).toBe(200);
  });
});
