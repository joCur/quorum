import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

const minimal = {
  OIDC_ISSUER_URL: "http://keycloak:8080/realms/quorum",
};

describe("loadConfig", () => {
  it("applies the documented defaults", () => {
    const config = loadConfig(minimal);
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe("info");
    expect(config.oidc.audience).toBe("quorum-api");
    expect(config.oidc.tenantClaim).toBe("tenant_id");
    expect(config.oidc.acceptedIssuers).toEqual([minimal.OIDC_ISSUER_URL]);
  });

  it("accepts the public issuer in addition to the internal one", () => {
    const config = loadConfig({
      ...minimal,
      OIDC_PUBLIC_ISSUER_URL: "http://localhost:8081/realms/quorum",
    });
    expect(config.oidc.acceptedIssuers).toEqual([
      "http://keycloak:8080/realms/quorum",
      "http://localhost:8081/realms/quorum",
    ]);
  });

  it("deduplicates identical issuers", () => {
    const config = loadConfig({ ...minimal, OIDC_PUBLIC_ISSUER_URL: minimal.OIDC_ISSUER_URL });
    expect(config.oidc.acceptedIssuers).toHaveLength(1);
  });

  it("fails loudly when the issuer is missing or not a URL", () => {
    expect(() => loadConfig({})).toThrow(/OIDC_ISSUER_URL/);
    expect(() => loadConfig({ OIDC_ISSUER_URL: "not-a-url" })).toThrow(/OIDC_ISSUER_URL/);
  });

  it("rejects an out-of-range port", () => {
    expect(() => loadConfig({ ...minimal, SERVER_PORT: "70000" })).toThrow(/SERVER_PORT/);
  });
});
