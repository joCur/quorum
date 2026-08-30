import { describe, expect, it } from "vitest";

import {
  applyAllowlist,
  checkRealmDrift,
  diffRealms,
  flatten,
  normalizeRealm,
  renderForDiff,
  unifiedDiff,
} from "./normalize.mjs";

/**
 * A miniature realm with the same shape as the real ones: a keyed client array, protocol mappers,
 * a substituted redirect list, and dev-only objects.
 */
function devRealm() {
  return {
    realm: "quorum",
    sslRequired: "none",
    clients: [
      {
        clientId: "quorum-pwa",
        publicClient: true,
        redirectUris: ["http://localhost:5173/*", "http://localhost:4173/*"],
        attributes: { "post.logout.redirect.uris": "http://localhost:5173/*" },
        protocolMappers: [
          { name: "tenant-id", config: { "claim.name": "tenant_id" } },
          { name: "quorum-api-audience", config: { "included.custom.audience": "quorum-api" } },
        ],
      },
      {
        clientId: "quorum-dev-cli",
        directAccessGrantsEnabled: true,
      },
    ],
    users: [{ username: "dev.alice", credentials: [{ value: "dev-password" }] }],
  };
}

function productionRealm() {
  return {
    realm: "quorum",
    sslRequired: "external",
    clients: [
      {
        clientId: "quorum-pwa",
        publicClient: true,
        redirectUris: ["$(env:QUORUM_PUBLIC_URL)/*"],
        attributes: { "post.logout.redirect.uris": "$(env:QUORUM_PUBLIC_URL)/*" },
        protocolMappers: [
          { name: "quorum-api-audience", config: { "included.custom.audience": "quorum-api" } },
          { name: "tenant-id", config: { "claim.name": "tenant_id" } },
        ],
      },
    ],
  };
}

const allowlist = {
  volatileFields: ["id", "containerId"],
  rules: [
    { kind: "devOnly", path: "users", reason: "fixtures" },
    { kind: "devOnly", path: "clients/quorum-dev-cli", reason: "password grant" },
    {
      kind: "fixedValues",
      path: "sslRequired",
      dev: "none",
      production: "external",
      reason: "TLS",
    },
    { kind: "envSubstitution", path: "clients/quorum-pwa/redirectUris", reason: "origins" },
    {
      kind: "envSubstitution",
      path: "clients/quorum-pwa/attributes/post.logout.redirect.uris",
      reason: "sign-out",
    },
  ],
};

describe("normalizeRealm", () => {
  it("keys object arrays by their identifier so order stops mattering", () => {
    const normalized = normalizeRealm(devRealm());
    expect(Object.keys(normalized.clients)).toEqual(["quorum-dev-cli", "quorum-pwa"]);
    expect(Object.keys(normalized.clients["quorum-pwa"].protocolMappers)).toEqual([
      "quorum-api-audience",
      "tenant-id",
    ]);
  });

  it("makes a reordered realm identical to the original", () => {
    const reordered = devRealm();
    reordered.clients.reverse();
    reordered.clients[1].protocolMappers.reverse();
    reordered.clients[1].redirectUris.reverse();
    expect(normalizeRealm(reordered)).toEqual(normalizeRealm(devRealm()));
  });

  it("drops volatile fields", () => {
    const withNoise = devRealm();
    withNoise.clients[0].id = "b6b0…";
    withNoise.clients[0].containerId = "quorum";
    expect(normalizeRealm(withNoise, allowlist.volatileFields)).toEqual(
      normalizeRealm(devRealm(), allowlist.volatileFields),
    );
  });

  it("emits object keys in sorted order", () => {
    expect(Object.keys(normalizeRealm({ b: 1, a: 2, c: 3 }))).toEqual(["a", "b", "c"]);
  });

  it("keeps empty containers visible as leaves", () => {
    expect([...flatten(normalizeRealm({ webOrigins: [], attributes: {} }))]).toEqual([
      ["attributes", "{}"],
      ["webOrigins", "[]"],
    ]);
  });
});

describe("diffRealms", () => {
  it("reports nothing for two equal realms", () => {
    expect(diffRealms(normalizeRealm(devRealm()), normalizeRealm(devRealm()))).toEqual([]);
  });

  it("classifies one-sided leaves and changed values", () => {
    const findings = diffRealms(normalizeRealm(devRealm()), normalizeRealm(productionRealm()));
    const byKind = (kind) => findings.filter((finding) => finding.kind === kind).map((f) => f.path);

    expect(byKind("changed")).toContain("sslRequired");
    expect(byKind("devOnly")).toContain("clients/quorum-dev-cli/directAccessGrantsEnabled");
    expect(byKind("devOnly")).toContain("users/dev.alice/credentials/0/value");
    expect(byKind("devOnly")).toContain("clients/quorum-pwa/redirectUris/1");
  });
});

describe("the allow-list", () => {
  it("passes when the two files are identical", () => {
    const identical = { ...allowlist, rules: [] };
    const result = checkRealmDrift(devRealm(), devRealm(), identical);
    expect(result.ok).toBe(true);
    expect(result.diff).toEqual([]);
  });

  it("passes for the documented differences", () => {
    const result = checkRealmDrift(devRealm(), productionRealm(), allowlist);
    expect(result.violations).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("fails on a smuggled mapper change, and names it in the diff", () => {
    const production = productionRealm();
    production.clients[0].protocolMappers[1].config["claim.name"] = "tid";

    const result = checkRealmDrift(devRealm(), production, allowlist);
    expect(result.ok).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      type: "unexpectedDifference",
      finding: {
        path: "clients/quorum-pwa/protocolMappers/tenant-id/config/claim.name",
        kind: "changed",
        dev: "tenant_id",
        production: "tid",
      },
    });

    const diff = result.diff.join("\n");
    expect(diff).toMatch(/^-\s+"tenant_id"$/m);
    expect(diff).toMatch(/^\+\s+"tid"$/m);
    // The documented differences are not dragged into the failure output.
    expect(diff).not.toContain("dev-password");
    expect(diff).not.toContain("quorum-dev-cli");
  });

  it("fails when a mapper exists in only one realm", () => {
    const production = productionRealm();
    production.clients[0].protocolMappers.push({ name: "groups", config: { full: "true" } });

    const result = checkRealmDrift(devRealm(), production, allowlist);
    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.finding?.path)).toContain(
      "clients/quorum-pwa/protocolMappers/groups/config/full",
    );
  });

  it("does not let a devOnly rule excuse a changed value under the same path", () => {
    const production = productionRealm();
    production.clients.push({ clientId: "quorum-dev-cli", directAccessGrantsEnabled: false });

    const result = checkRealmDrift(devRealm(), production, allowlist);
    expect(result.ok).toBe(false);
    expect(result.violations[0].finding).toMatchObject({
      path: "clients/quorum-dev-cli/directAccessGrantsEnabled",
      kind: "changed",
    });
  });

  it("rejects a fixedValues rule whose values no longer match", () => {
    const production = productionRealm();
    production.sslRequired = "all";

    const result = checkRealmDrift(devRealm(), production, allowlist);
    expect(result.ok).toBe(false);
    expect(result.violations.map((violation) => violation.finding?.path)).toContain("sslRequired");
  });

  it("rejects a hard-coded production origin under a substitution rule", () => {
    const production = productionRealm();
    production.clients[0].redirectUris = ["https://quorum.example.com/*"];

    const result = checkRealmDrift(devRealm(), production, allowlist);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        type: "substitutionExpected",
        path: "clients/quorum-pwa/redirectUris/0",
      }),
    );
  });

  it("rejects a substitution that leaked into the development realm", () => {
    const dev = devRealm();
    dev.clients[0].redirectUris = ["$(env:QUORUM_PUBLIC_URL)/*"];

    const result = checkRealmDrift(dev, productionRealm(), allowlist);
    expect(result.ok).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({ type: "substitutionUnexpected" }),
    );
  });

  it("reports a rule that no longer matches anything, so the list cannot go stale", () => {
    const withExtraRule = {
      ...allowlist,
      rules: [...allowlist.rules, { kind: "devOnly", path: "groups", reason: "obsolete" }],
    };

    const result = checkRealmDrift(devRealm(), productionRealm(), withExtraRule);
    expect(result.ok).toBe(false);
    expect(result.violations).toEqual([
      expect.objectContaining({
        type: "staleRule",
        rule: expect.objectContaining({ path: "groups" }),
      }),
    ]);
  });

  it("keeps counting a rule that covers many leaves as used", () => {
    const { violations } = applyAllowlist(
      diffRealms(normalizeRealm(devRealm()), normalizeRealm(productionRealm())),
      { rules: allowlist.rules },
    );
    expect(violations).toEqual([]);
  });
});

describe("the rendered diff", () => {
  it("omits subtrees whose every leaf is allowed", () => {
    const normalized = normalizeRealm(devRealm());
    const allowed = new Set(
      [...flatten(normalized).keys()].filter((path) => path.startsWith("users/")),
    );
    expect(renderForDiff(normalized, allowed).join("\n")).not.toContain("users");
  });

  it("produces a unified diff with context and hunk markers", () => {
    const left = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"];
    const right = [...left];
    right[0] = "A";
    right[9] = "J";

    const diff = unifiedDiff(left, right, { leftLabel: "left", rightLabel: "right" });
    expect(diff[0]).toBe("--- left");
    expect(diff[1]).toBe("+++ right");
    expect(diff).toContain("-a");
    expect(diff).toContain("+A");
    expect(diff).toContain("@@");
    // The untouched middle is not printed.
    expect(diff).not.toContain(" e");
  });

  it("is empty for identical input", () => {
    expect(unifiedDiff(["a"], ["a"], { leftLabel: "l", rightLabel: "r" })).toEqual([]);
  });
});
