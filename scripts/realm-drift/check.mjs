#!/usr/bin/env node
/**
 * CLI for the realm drift guard. See `normalize.mjs` for what it actually checks and
 * `infra/keycloak/README.md` for the allow-list format.
 *
 * Exit codes: 0 when the realms agree (or the check is not armed yet), 1 on unclaimed drift, 2 when
 * the guard itself is misconfigured — a missing or unparsable allow-list, unreadable JSON.
 *
 * Reads files and prints; no network, no containers, so it belongs in the fast checks job.
 */

import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { checkRealmDrift } from "./normalize.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const keycloakDir = path.join(repoRoot, "infra", "keycloak");

const DEV_REALM = path.join(keycloakDir, "realm-quorum.json");
const PRODUCTION_REALM = path.join(keycloakDir, "realm-production.json");
const ALLOWLIST = path.join(keycloakDir, "realm-diff-allowlist.json");

function relative(file) {
  return path.relative(repoRoot, file);
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`realm drift: cannot read ${relative(file)} — ${error.message}`);
    process.exit(2);
  }
}

function describeViolation(violation) {
  switch (violation.type) {
    case "unexpectedDifference": {
      const { path: at, kind, dev, production } = violation.finding;
      if (kind === "devOnly") return `  ${at}\n      only in development: ${JSON.stringify(dev)}`;
      if (kind === "productionOnly")
        return `  ${at}\n      only in production: ${JSON.stringify(production)}`;
      return `  ${at}\n      development: ${JSON.stringify(dev)}\n      production:  ${JSON.stringify(production)}`;
    }
    case "substitutionExpected":
      return `  ${violation.path}\n      production must use an import-time substitution such as $(env:QUORUM_PUBLIC_URL), found ${JSON.stringify(violation.value)}`;
    case "substitutionUnexpected":
      return `  ${violation.path}\n      development must use a literal value, found the substitution ${JSON.stringify(violation.value)}`;
    case "staleRule":
      return `  ${violation.rule.path}\n      allow-list rule "${violation.rule.kind}" no longer matches any difference. The realms have converged here — remove the rule from ${relative(ALLOWLIST)}.`;
    default:
      return `  ${JSON.stringify(violation)}`;
  }
}

// The production realm arrives with the release documentation. Until it exists there is nothing to
// compare, and the guard says so rather than failing a build for a file that is not due yet — it
// arms itself the moment the second file lands.
if (!existsSync(PRODUCTION_REALM)) {
  console.log(
    `realm drift: skipped — ${relative(PRODUCTION_REALM)} does not exist yet.\n` +
      `The guard arms itself automatically once both realm files are present.`,
  );
  process.exit(0);
}

if (!existsSync(DEV_REALM)) {
  console.error(`realm drift: ${relative(DEV_REALM)} is missing.`);
  process.exit(2);
}

const allowlist = readJson(ALLOWLIST);
const result = checkRealmDrift(readJson(DEV_REALM), readJson(PRODUCTION_REALM), allowlist, {
  dev: relative(DEV_REALM),
  production: relative(PRODUCTION_REALM),
});

if (result.ok) {
  console.log(
    `realm drift: ok — ${relative(DEV_REALM)} and ${relative(PRODUCTION_REALM)} differ only in the ${allowlist.rules.length} documented ways.`,
  );
  process.exit(0);
}

console.error(
  `realm drift: ${result.violations.length} difference(s) between ${relative(DEV_REALM)} and ` +
    `${relative(PRODUCTION_REALM)} are not covered by ${relative(ALLOWLIST)}.\n`,
);
for (const violation of result.violations) console.error(describeViolation(violation));

if (result.diff.length) {
  console.error("\nNormalized diff (documented differences omitted):\n");
  for (const line of result.diff) console.error(line);
}

console.error(
  `\nEither make the two realms agree, or — if the difference is intended — add a rule with a ` +
    `reason to ${relative(ALLOWLIST)} and describe it in ${relative(path.join(keycloakDir, "README.md"))}.`,
);
process.exit(1);
