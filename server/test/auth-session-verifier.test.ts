import { describe, expect, it } from "vitest";
import { AuthError } from "../src/auth/errors.js";
import { extractBearerToken } from "../src/auth/token-verifier.js";
import { createTestAuth } from "./sessions.js";

/**
 * Replaces `auth-token-verifier.test.ts`.
 *
 * The cases that survive the move are the ones that describe the *contract*: a valid credential
 * produces a tenant-scoped context, an unusable one produces an `AuthError` with a stable code,
 * and a request without a tenant is refused rather than silently unscoped. The cases that do not
 * survive are the ones that were about the token format — wrong issuer, wrong audience, wrong
 * signing algorithm, a token signed by a key we do not know. There is no issuer and no audience
 * any more, so those are not weaker tests, they are tests of a thing that no longer exists.
 */
const fixture = await createTestAuth();

describe("createSessionVerifier", () => {
  it("produces the tenant-scoped context for a valid session token", async () => {
    const token = await fixture.issueSessionToken({
      subject: "user-alice",
      tenantId: "tenant-acme",
      username: "dev.alice",
      roles: ["quorum-user", "quorum-admin"],
    });

    const context = await fixture.verify(token);
    expect(context.userId).toBe("user-alice");
    expect(context.tenantId).toBe("tenant-acme");
    expect(context.roles).toEqual(["quorum-user", "quorum-admin"]);
    expect(context.email).toBe("dev.alice@acme.dev.invalid");
    expect(context.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("refuses an empty credential", async () => {
    await expect(fixture.verify("")).rejects.toMatchObject({ code: "missing_token" });
  });

  it("refuses a token that is not a session", async () => {
    await expect(fixture.verify("not-a-session-token")).rejects.toMatchObject({
      code: "invalid_token",
    });
  });

  it("refuses a session whose user carries no tenant (ADR-001)", async () => {
    const token = await fixture.issueSessionToken({
      subject: "user-tenantless",
      tenantId: null,
      username: "dev.tenantless",
    });

    const error = await fixture.verify(token).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(AuthError);
    expect(error).toMatchObject({ code: "missing_tenant", statusCode: 403 });
  });

  it("stops accepting a token whose session was revoked", async () => {
    // Not possible with a self-contained JWT: a Keycloak access token stayed valid until it
    // expired, however thoroughly the session behind it had been ended. This is the one security
    // property the in-process provider adds rather than removes.
    const token = await fixture.issueSessionToken({
      subject: "user-revoked",
      tenantId: "tenant-acme",
      username: "dev.revoked",
    });
    await expect(fixture.verify(token)).resolves.toMatchObject({ userId: "user-revoked" });

    await fixture.revokeSessions("user-revoked");
    await expect(fixture.verify(token)).rejects.toMatchObject({ code: "invalid_token" });
  });
});

describe("extractBearerToken", () => {
  it("reads the token out of an Authorization header", () => {
    expect(extractBearerToken("Bearer abc.def")).toBe("abc.def");
    expect(extractBearerToken("bearer  abc.def")).toBe("abc.def");
  });

  it("refuses a missing or malformed header", () => {
    expect(() => extractBearerToken(undefined)).toThrow(AuthError);
    expect(() => extractBearerToken("Basic abc")).toThrow(/Bearer <token>/);
  });
});
