import { describe, expect, it } from "vitest";
import { loadConfig, resolveOidcConfig } from "../src/config.js";

const minimal = {
  DATABASE_URL: "postgres://quorum:secret@postgres:5432/quorum",
  S3_ENDPOINT: "http://minio:9000",
  S3_BUCKET: "recordings",
  S3_ACCESS_KEY: "quorum-admin",
  S3_SECRET_KEY: "secret",
  OIDC_ISSUER_URL: "http://keycloak:8080/realms/quorum",
};

describe("loadConfig", () => {
  it("applies the documented defaults", () => {
    const config = loadConfig(minimal);
    expect(config.HOST).toBe("0.0.0.0");
    expect(config.PORT).toBe(8080);
    expect(config.LOG_LEVEL).toBe("info");
    expect(config.S3_SSE).toBe("AES256");
    expect(config.RECORDING_ALLOW_HEADER_AUTH).toBe(false);
    expect(config.OIDC_AUDIENCE).toBe("quorum-api");
    expect(config.OIDC_TENANT_CLAIM).toBe("tenant_id");
  });

  it("fails loudly when the issuer is missing or not a URL", () => {
    expect(() => loadConfig({ ...minimal, OIDC_ISSUER_URL: undefined })).toThrow(/OIDC_ISSUER_URL/);
    expect(() => loadConfig({ ...minimal, OIDC_ISSUER_URL: "not-a-url" })).toThrow(
      /OIDC_ISSUER_URL/,
    );
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

describe("resolveOidcConfig", () => {
  it("accepts only the internal issuer when no public one is configured", () => {
    expect(resolveOidcConfig(loadConfig(minimal)).acceptedIssuers).toEqual([
      "http://keycloak:8080/realms/quorum",
    ]);
  });

  it("accepts the public issuer in addition to the internal one", () => {
    const oidc = resolveOidcConfig(
      loadConfig({ ...minimal, OIDC_PUBLIC_ISSUER_URL: "http://localhost:8081/realms/quorum" }),
    );
    expect(oidc.acceptedIssuers).toEqual([
      "http://keycloak:8080/realms/quorum",
      "http://localhost:8081/realms/quorum",
    ]);
    expect(oidc.issuer).toBe("http://keycloak:8080/realms/quorum");
  });

  it("deduplicates identical issuers", () => {
    const oidc = resolveOidcConfig(
      loadConfig({ ...minimal, OIDC_PUBLIC_ISSUER_URL: minimal.OIDC_ISSUER_URL }),
    );
    expect(oidc.acceptedIssuers).toHaveLength(1);
  });
});
