import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/app.js";
import { createTokenVerifiers } from "../src/auth/token-verifier.js";
import {
  KeycloakTenantProvisioner,
  ProvisioningError,
  derivedTenantId,
  type TenantProvisioner,
} from "../src/auth/provisioning.js";
import { InMemoryRecordingStorage } from "../src/recording/storage/memory.js";
import { InMemoryJobQueue } from "../src/recording/queue/memory.js";
import { InMemoryMeetingStore } from "../src/meetings/memory.js";
import { AUDIENCE, INTERNAL_ISSUER, ISSUER, createTestKeyPair, signAccessToken } from "./keys.js";
import type { TestKeyPair } from "./keys.js";

const keys: TestKeyPair = await createTestKeyPair();
const USER = "22222222-2222-4222-8222-222222222222";

async function buildApp(provisioning?: TenantProvisioner): Promise<FastifyInstance> {
  const app = await buildServer({
    storage: new InMemoryRecordingStorage(),
    queue: new InMemoryJobQueue(),
    meetings: new InMemoryMeetingStore(),
    auth: createTokenVerifiers({
      issuers: [INTERNAL_ISSUER, ISSUER],
      audience: AUDIENCE,
      tenantClaim: "tenant_id",
      keySource: keys.jwks,
    }),
    ...(provisioning ? { provisioning } : {}),
  });
  await app.ready();
  return app;
}

let app: FastifyInstance;

afterEach(async () => {
  await app.close();
});

describe("the route that gives an account a tenant", () => {
  it("provisions a caller whose token carries no tenant, and says the token is now stale", async () => {
    const calls: string[] = [];
    app = await buildApp({
      ensureTenant: async (userId) => {
        calls.push(userId);
        return derivedTenantId(userId);
      },
    });

    const token = await signAccessToken(keys, { subject: USER, tenantId: null });
    const response = await app.inject({
      method: "POST",
      url: "/api/me/tenant",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ tenantId: derivedTenantId(USER), tokenStale: true });
    expect(calls).toEqual([USER]);
  });

  it("still refuses every other route for that same token", async () => {
    app = await buildApp({ ensureTenant: async (userId) => derivedTenantId(userId) });
    const token = await signAccessToken(keys, { subject: USER, tenantId: null });

    // This is the invariant the whole design turns on: `tenantOptional` opens exactly one door.
    for (const url of ["/api/me", "/api/meetings"]) {
      const response = await app.inject({
        method: "GET",
        url,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ error: "missing_tenant" });
    }
  });

  it("refuses an unauthenticated caller like any other route", async () => {
    app = await buildApp({ ensureTenant: async (userId) => derivedTenantId(userId) });

    const anonymous = await app.inject({ method: "POST", url: "/api/me/tenant" });
    expect(anonymous.statusCode).toBe(401);

    const forged = await app.inject({
      method: "POST",
      url: "/api/me/tenant",
      headers: { authorization: "Bearer not-a-token" },
    });
    expect(forged.statusCode).toBe(401);
  });

  it("answers a token that already has a tenant without inventing a second one", async () => {
    app = await buildApp({ ensureTenant: async () => "tenant-acme" });
    const token = await signAccessToken(keys, { subject: USER, tenantId: "tenant-acme" });

    const response = await app.inject({
      method: "POST",
      url: "/api/me/tenant",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ tenantId: "tenant-acme" });
  });

  it("reports a provider that will not cooperate as 503, not 500", async () => {
    app = await buildApp({
      ensureTenant: async () => {
        throw new ProvisioningError("nope");
      },
    });
    const token = await signAccessToken(keys, { subject: USER, tenantId: null });

    const response = await app.inject({
      method: "POST",
      url: "/api/me/tenant",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ error: "provisioning_unavailable" });
  });

  it("does not exist at all when the deployment configured no provisioner", async () => {
    app = await buildApp();
    const token = await signAccessToken(keys, { subject: USER, tenantId: null });

    const response = await app.inject({
      method: "POST",
      url: "/api/me/tenant",
      headers: { authorization: `Bearer ${token}` },
    });
    // Default-deny runs before routing, so a token with no tenant is refused on the way in — the
    // route's absence is not a way to learn anything.
    expect(response.statusCode).toBe(403);
  });
});

describe("KeycloakTenantProvisioner", () => {
  interface Recorded {
    url: string;
    method: string;
    body: unknown;
  }

  let recorded: Recorded[];
  let user: Record<string, unknown>;

  function stubFetch(): typeof globalThis.fetch {
    return (async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = String(input);
      recorded.push({
        url,
        method: init.method ?? "GET",
        body: typeof init.body === "string" ? JSON.parse(init.body) : init.body,
      });

      if (url.endsWith("/protocol/openid-connect/token")) {
        return new Response(JSON.stringify({ access_token: "service-token", expires_in: 60 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (init.method === "PUT") {
        user = JSON.parse(init.body as string) as Record<string, unknown>;
        return new Response(null, { status: 204 });
      }
      return new Response(JSON.stringify(user), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
  }

  function provisioner(): KeycloakTenantProvisioner {
    return new KeycloakTenantProvisioner({
      baseUrl: "http://keycloak:8080",
      realm: "quorum",
      clientId: "quorum-provisioner",
      clientSecret: "secret",
      fetch: stubFetch(),
    });
  }

  beforeEach(() => {
    recorded = [];
    user = { id: USER, username: "new.user", firstName: "New", enabled: true };
  });

  it("writes the tenant attribute and keeps the rest of the user intact", async () => {
    const tenantId = await provisioner().ensureTenant(USER);

    expect(tenantId).toBe(derivedTenantId(USER));
    expect(user).toMatchObject({
      username: "new.user",
      firstName: "New",
      enabled: true,
      attributes: { tenant_id: [derivedTenantId(USER)] },
    });
  });

  it("writes nothing when the user already has a tenant", async () => {
    user = { id: USER, attributes: { tenant_id: ["tenant-acme"] } };

    expect(await provisioner().ensureTenant(USER)).toBe("tenant-acme");
    expect(recorded.some((call) => call.method === "PUT")).toBe(false);
  });

  it("gives two racing calls the same tenant and asks the provider once", async () => {
    const instance = provisioner();
    const [first, second] = await Promise.all([
      instance.ensureTenant(USER),
      instance.ensureTenant(USER),
    ]);

    expect(first).toBe(second);
    expect(recorded.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  it("reuses the service-account token across calls", async () => {
    const instance = provisioner();
    await instance.ensureTenant(USER);
    user = { id: USER };
    await instance.ensureTenant(USER);

    const tokenRequests = recorded.filter((call) =>
      call.url.endsWith("/protocol/openid-connect/token"),
    );
    expect(tokenRequests).toHaveLength(1);
  });

  it("raises ProvisioningError, without the response body, when the client is refused", async () => {
    const instance = new KeycloakTenantProvisioner({
      baseUrl: "http://keycloak:8080",
      realm: "quorum",
      clientId: "quorum-provisioner",
      clientSecret: "wrong",
      fetch: (async () =>
        new Response(JSON.stringify({ error: "unauthorized_client", secret: "wrong" }), {
          status: 401,
        })) as typeof globalThis.fetch,
    });

    await expect(instance.ensureTenant(USER)).rejects.toThrow(ProvisioningError);
    await expect(instance.ensureTenant(USER)).rejects.not.toThrow(/wrong/);
  });

  it("raises ProvisioningError when the provider cannot be reached", async () => {
    const instance = new KeycloakTenantProvisioner({
      baseUrl: "http://keycloak:8080",
      realm: "quorum",
      clientId: "quorum-provisioner",
      clientSecret: "secret",
      fetch: (async () => {
        throw new Error("ECONNREFUSED");
      }) as typeof globalThis.fetch,
    });

    await expect(instance.ensureTenant(USER)).rejects.toThrow(ProvisioningError);
  });
});
