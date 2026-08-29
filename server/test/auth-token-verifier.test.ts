import { describe, expect, it } from "vitest";
import { AuthError } from "../src/auth/errors.js";
import {
  createTokenVerifier,
  extractBearerToken,
  keycloakJwksUri,
} from "../src/auth/token-verifier.js";
import type { TokenVerifier } from "../src/auth/token-verifier.js";
import { AUDIENCE, INTERNAL_ISSUER, ISSUER, createTestKeyPair, signAccessToken } from "./keys.js";
import type { TestKeyPair } from "./keys.js";

const keys: TestKeyPair = await createTestKeyPair();
const otherKeys: TestKeyPair = await createTestKeyPair("attacker-key");

const verify: TokenVerifier = createTokenVerifier({
  issuers: [ISSUER, INTERNAL_ISSUER],
  audience: AUDIENCE,
  keySource: keys.jwks,
});

async function expectAuthError(promise: Promise<unknown>, code: string): Promise<AuthError> {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error, `expected an AuthError with code "${code}"`).toBeInstanceOf(AuthError);
  const authError = error as AuthError;
  expect(authError.code).toBe(code);
  return authError;
}

describe("createTokenVerifier", () => {
  it("accepts a valid token and derives the tenant-scoped context", async () => {
    const token = await signAccessToken(keys, {
      subject: "user-42",
      tenantId: "tenant-acme",
      roles: ["quorum-user", "quorum-admin"],
    });

    const context = await verify(token);

    expect(context.userId).toBe("user-42");
    expect(context.tenantId).toBe("tenant-acme");
    expect(context.roles).toEqual(["quorum-user", "quorum-admin"]);
    expect(context.username).toBe("dev.alice");
    expect(context.issuer).toBe(ISSUER);
    expect(context.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("accepts the container-internal issuer as well", async () => {
    const token = await signAccessToken(keys, { issuer: INTERNAL_ISSUER });
    await expect(verify(token)).resolves.toMatchObject({ issuer: INTERNAL_ISSUER });
  });

  it("accepts a token whose audience array contains the API audience", async () => {
    const token = await signAccessToken(keys, { audience: ["account", AUDIENCE] });
    await expect(verify(token)).resolves.toMatchObject({ tenantId: "tenant-acme" });
  });

  it("rejects an expired token", async () => {
    const now = Math.floor(Date.now() / 1000);
    const token = await signAccessToken(keys, { issuedAt: now - 600, expiresAt: now - 300 });
    await expectAuthError(verify(token), "expired_token");
  });

  it("rejects a token from a foreign issuer", async () => {
    const token = await signAccessToken(keys, { issuer: "https://evil.example.com/realms/quorum" });
    await expectAuthError(verify(token), "invalid_issuer");
  });

  it("rejects a token issued for another audience", async () => {
    const token = await signAccessToken(keys, { audience: "some-other-api" });
    await expectAuthError(verify(token), "invalid_audience");
  });

  it("rejects a token signed with an unknown key", async () => {
    const token = await signAccessToken(otherKeys);
    await expectAuthError(verify(token), "invalid_token");
  });

  it("rejects a structurally broken token", async () => {
    await expectAuthError(verify("not-a-jwt"), "invalid_token");
    await expectAuthError(verify(""), "missing_token");
  });

  it("rejects an unsigned (alg=none) token", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: ISSUER,
        aud: AUDIENCE,
        sub: "user-42",
        tenant_id: "tenant-acme",
        exp: Math.floor(Date.now() / 1000) + 300,
      }),
    ).toString("base64url");
    await expectAuthError(verify(`${header}.${payload}.`), "invalid_token");
  });

  it("rejects a token without a tenant claim, because nothing could be scoped", async () => {
    const token = await signAccessToken(keys, { tenantId: null });
    const error = await expectAuthError(verify(token), "missing_tenant");
    expect(error.statusCode).toBe(403);
  });

  it("honors a configured non-default tenant claim", async () => {
    const custom = createTokenVerifier({
      issuers: [ISSUER],
      audience: AUDIENCE,
      tenantClaim: "org_id",
      keySource: keys.jwks,
    });
    await expectAuthError(custom(await signAccessToken(keys)), "missing_tenant");
  });

  it("requires at least one accepted issuer", () => {
    expect(() =>
      createTokenVerifier({ issuers: [], audience: AUDIENCE, keySource: keys.jwks }),
    ).toThrow(/at least one accepted issuer/);
  });
});

describe("extractBearerToken", () => {
  it("extracts the token and tolerates header casing", () => {
    expect(extractBearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(extractBearerToken("bearer abc.def.ghi")).toBe("abc.def.ghi");
  });

  it("rejects a missing or malformed header", () => {
    expect(() => extractBearerToken(undefined)).toThrow(AuthError);
    expect(() => extractBearerToken("")).toThrow(AuthError);
    expect(() => extractBearerToken("Basic dXNlcjpwYXNz")).toThrow(AuthError);
    expect(() => extractBearerToken("Bearer")).toThrow(AuthError);
  });
});

describe("keycloakJwksUri", () => {
  it("derives the realm certificate endpoint and tolerates a trailing slash", () => {
    expect(keycloakJwksUri(ISSUER)).toBe(`${ISSUER}/protocol/openid-connect/certs`);
    expect(keycloakJwksUri(`${ISSUER}/`)).toBe(`${ISSUER}/protocol/openid-connect/certs`);
  });
});
