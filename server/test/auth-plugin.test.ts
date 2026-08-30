import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildServer } from "../src/app.js";
import { createTestAuth } from "./sessions.js";
import { InMemoryRecordingStorage } from "../src/recording/storage/memory.js";
import { InMemoryJobQueue } from "../src/recording/queue/memory.js";

const fixture = await createTestAuth();

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildServer({
    storage: new InMemoryRecordingStorage(),
    queue: new InMemoryJobQueue(),
    auth: {
      verifyAccessToken: fixture.verify,
    },
  });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

describe("auth plugin", () => {
  it("serves the health endpoint without a token", async () => {
    const response = await app.inject({ method: "GET", url: "/healthz" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: "ok", service: "quorum-server" });
  });

  it("denies a protected route without an Authorization header", async () => {
    const response = await app.inject({ method: "GET", url: "/api/me" });
    expect(response.statusCode).toBe(401);
    expect(response.headers["www-authenticate"]).toContain("Bearer");
    expect(response.json()).toMatchObject({ error: "missing_token" });
  });

  it("denies an unknown route as well (default-deny)", async () => {
    const response = await app.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(response.statusCode).toBe(401);
  });

  it("denies the recording upgrade without a token", async () => {
    const response = await app.inject({ method: "GET", url: "/ws/recording" });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "missing_token" });
  });

  it("exposes the tenant-scoped context for a valid token", async () => {
    const token = await fixture.issueSessionToken({
      subject: "user-42",
      tenantId: "tenant-globex",
      roles: ["quorum-user"],
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      userId: "user-42",
      tenantId: "tenant-globex",
      roles: ["quorum-user"],
    });
  });

  /*
   * SPIKE: the table this replaces had four rows — expired, wrong issuer, wrong audience, no
   * tenant. Two of them described a token format that no longer exists (there is no issuer and no
   * audience to get wrong), and "expired" is no longer something a caller can present: an expired
   * session is simply absent from the store, and the API answers `invalid_token`. What remains
   * testable at this level is that an unusable credential is refused with a stable code, and that
   * a user without a tenant is refused with 403 rather than served unscoped.
   */
  it.each([
    ["unknown", "not-a-real-session-token", 401, "invalid_token"],
    ["tampered", "abcdef.0123456789", 401, "invalid_token"],
  ] as const)("rejects an %s token with %i", async (_name, token, status, code) => {
    const response = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: code });
  });

  it("rejects a session whose user has no tenant with 403", async () => {
    const token = await fixture.issueSessionToken({
      subject: "user-no-tenant",
      username: "dev.notenant",
      tenantId: null,
    });
    const response = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: "missing_tenant" });
  });

  it("rejects a malformed Authorization header", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ error: "malformed_authorization_header" });
  });

  it("does not leak a context between requests", async () => {
    const token = await fixture.issueSessionToken({ subject: "user-1", tenantId: "tenant-acme" });
    const authenticated = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(authenticated.statusCode).toBe(200);

    const anonymous = await app.inject({ method: "GET", url: "/api/me" });
    expect(anonymous.statusCode).toBe(401);
  });
});

describe("unauthenticated instance", () => {
  it("has no protected identity route and leaves the recording upgrade to its provider", async () => {
    const plain = await buildServer({
      storage: new InMemoryRecordingStorage(),
      queue: new InMemoryJobQueue(),
      contextProvider: {
        async resolve() {
          return { tenantId: "t", userId: "u" };
        },
      },
    });
    await plain.ready();

    expect((await plain.inject({ method: "GET", url: "/healthz" })).statusCode).toBe(200);
    expect((await plain.inject({ method: "GET", url: "/api/me" })).statusCode).toBe(404);

    await plain.close();
  });
});
