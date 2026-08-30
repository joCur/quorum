import { describe, expect, it } from "vitest";
import { loadConfig, resolveAuthConfig } from "../src/config.js";

const minimal = {
  DATABASE_URL: "postgres://quorum:secret@postgres:5432/quorum",
  S3_ENDPOINT: "http://minio:9000",
  S3_BUCKET: "recordings",
  S3_ACCESS_KEY: "quorum-admin",
  S3_SECRET_KEY: "secret",
  AUTH_SECRET: "a-secret-that-is-at-least-32-characters-long",
  AUTH_BASE_URL: "http://localhost:8080",
};

describe("loadConfig", () => {
  it("applies the documented defaults", () => {
    const config = loadConfig(minimal);
    expect(config.HOST).toBe("0.0.0.0");
    expect(config.PORT).toBe(8080);
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.S3_SSE).toBe("AES256");
    expect(config.RECORDING_ALLOW_HEADER_AUTH).toBe(false);
    expect(config.AUTH_SESSION_TTL_SECONDS).toBe(8 * 60 * 60);
    expect(config.AUTH_TRUSTED_ORIGINS).toBe("");
  });

  it("fails loudly when the auth base URL is missing or not a URL", () => {
    expect(() => loadConfig({ ...minimal, AUTH_BASE_URL: undefined })).toThrow(/AUTH_BASE_URL/);
    expect(() => loadConfig({ ...minimal, AUTH_BASE_URL: "not-a-url" })).toThrow(/AUTH_BASE_URL/);
  });

  it("refuses a signing secret short enough to be guessable", () => {
    // SPIKE: with Keycloak the API held no signing key at all — it only ever verified against a
    // published JWKS. This one value now protects every session in the deployment, so a weak one
    // has to fail at startup rather than in production.
    expect(() => loadConfig({ ...minimal, AUTH_SECRET: "too-short" })).toThrow(/AUTH_SECRET/);
    expect(() => loadConfig({ ...minimal, AUTH_SECRET: undefined })).toThrow(/AUTH_SECRET/);
  });

  it("rejects an out-of-range port", () => {
    expect(() => loadConfig({ ...minimal, PORT: "70000" })).toThrow(/PORT/);
  });

  it("keeps the header auth gate off unless it is explicitly enabled", () => {
    expect(
      loadConfig({ ...minimal, RECORDING_ALLOW_HEADER_AUTH: "true" }).RECORDING_ALLOW_HEADER_AUTH,
    ).toBe(true);
    expect(loadConfig(minimal).RECORDING_ALLOW_HEADER_AUTH).toBe(false);
  });
});

describe("resolveAuthConfig", () => {
  it("always trusts the app's own base URL", () => {
    expect(resolveAuthConfig(loadConfig(minimal)).trustedOrigins).toEqual([
      "http://localhost:8080",
    ]);
  });

  it("adds the configured origins and deduplicates them", () => {
    const auth = resolveAuthConfig(
      loadConfig({
        ...minimal,
        AUTH_TRUSTED_ORIGINS: "http://localhost:5173, http://localhost:8080",
      }),
    );
    expect(auth.trustedOrigins).toEqual(["http://localhost:8080", "http://localhost:5173"]);
  });

  it("carries the session lifetime through", () => {
    expect(
      resolveAuthConfig(loadConfig({ ...minimal, AUTH_SESSION_TTL_SECONDS: "900" }))
        .sessionTtlSeconds,
    ).toBe(900);
  });
});
