import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { createTokenVerifier } from "../src/auth/token-verifier.js";
import type { ServerConfig } from "../src/config.js";
import { AUDIENCE, INTERNAL_ISSUER, ISSUER, createTestKeyPair, signAccessToken } from "./keys.js";
import type { TestKeyPair } from "./keys.js";

const keys: TestKeyPair = await createTestKeyPair();

const config: ServerConfig = {
  host: "127.0.0.1",
  port: 0,
  logLevel: "silent",
  oidc: {
    issuer: INTERNAL_ISSUER,
    acceptedIssuers: [INTERNAL_ISSUER, ISSUER],
    jwksUri: undefined,
    audience: AUDIENCE,
    tenantClaim: "tenant_id",
  },
};

let app: FastifyInstance;

beforeAll(async () => {
  app = await buildApp({
    config,
    verifyAccessToken: createTokenVerifier({
      issuers: config.oidc.acceptedIssuers,
      audience: config.oidc.audience,
      tenantClaim: config.oidc.tenantClaim,
      keySource: keys.jwks,
    }),
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

  it("denies a protected route for an unknown route as well (default-deny)", async () => {
    const response = await app.inject({ method: "GET", url: "/api/does-not-exist" });
    expect(response.statusCode).toBe(401);
  });

  it("exposes the tenant-scoped context for a valid token", async () => {
    const token = await signAccessToken(keys, {
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

  it.each([
    ["expired", { issuedAt: 1_700_000_000, expiresAt: 1_700_000_300 }, 401, "expired_token"],
    ["wrong issuer", { issuer: "https://evil.example.com/realms/quorum" }, 401, "invalid_issuer"],
    ["wrong audience", { audience: "some-other-api" }, 401, "invalid_audience"],
    ["no tenant", { tenantId: null }, 403, "missing_tenant"],
  ] as const)("rejects a %s token with %i", async (_name, overrides, status, code) => {
    const token = await signAccessToken(keys, overrides);
    const response = await app.inject({
      method: "GET",
      url: "/api/me",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(status);
    expect(response.json()).toMatchObject({ error: code });
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
    const token = await signAccessToken(keys, { subject: "user-1", tenantId: "tenant-acme" });
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
