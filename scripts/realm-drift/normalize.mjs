/**
 * Drift guard for the two Keycloak realm files.
 *
 * The production realm is derived from the development realm by hand. That derivation is exactly
 * the kind of thing that rots quietly: a stale post-logout redirect list survived in the derived
 * production realm until someone happened to read both files side by side, and sign-out would have
 * failed on the first deployment that used it. A protocol mapper added to one file and forgotten in
 * the other is the same class of bug, and it only surfaces as a broken login in the environment
 * nobody tested.
 *
 * So both files are normalized into a canonical shape, compared leaf by leaf, and every remaining
 * difference has to be claimed by a rule in the allow-list next to the realms. Anything unclaimed
 * fails the build with a diff a reviewer can read.
 *
 * This module is pure: it takes parsed JSON and returns findings. The CLI wrapper in `check.mjs`
 * does the file I/O and the exit codes.
 */

/**
 * Fields an array of objects may be identified by. Keying an array by one of these turns "third
 * entry in the clients array" into "the quorum-pwa client", so reordering two clients is not drift
 * and a mapper added in the middle of a list does not shift every path after it.
 */
const KEY_FIELD_CANDIDATES = ["clientId", "username", "name"];

/** Escapes a path segment so that a `/` inside a key cannot forge a path boundary. */
function escapeSegment(segment) {
  return String(segment).replaceAll("~", "~0").replaceAll("/", "~1");
}

/** Joins a parent path and one segment into a canonical path string. */
export function joinPath(parent, segment) {
  const escaped = escapeSegment(segment);
  return parent === "" ? escaped : `${parent}/${escaped}`;
}

/** True when `path` is `prefix` itself or lives underneath it. */
export function isUnder(path, prefix) {
  return path === prefix || path.startsWith(`${prefix}/`);
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Picks the field an array of objects is identified by, so that reordering the array is not a
 * difference. An array qualifies only when every element is an object carrying the same field —
 * that keeps the rule from guessing on arbitrary data.
 */
function keyFieldFor(array) {
  if (array.length === 0 || !array.every(isPlainObject)) return null;
  return (
    KEY_FIELD_CANDIDATES.find((field) =>
      array.every((element) => typeof element[field] === "string"),
    ) ?? null
  );
}

/**
 * Rewrites a parsed realm into a canonical form:
 *
 * - volatile fields are dropped,
 * - arrays of identifiable objects (clients, users, roles, protocol mappers) become objects keyed
 *   by their identifier, so order and position stop mattering,
 * - remaining arrays are sorted by their serialized value, so a reordered redirect URI list is not
 *   drift,
 * - object keys are emitted in sorted order.
 */
export function normalizeRealm(value, volatileFields = []) {
  const volatile = new Set(volatileFields);

  function walk(node) {
    if (Array.isArray(node)) {
      const keyField = keyFieldFor(node);
      if (keyField) {
        const keyed = {};
        for (const element of node) {
          keyed[element[keyField]] = walk(element);
        }
        return walk(keyed);
      }
      return node.map(walk).sort((a, b) => {
        const left = JSON.stringify(a);
        const right = JSON.stringify(b);
        return left < right ? -1 : left > right ? 1 : 0;
      });
    }

    if (isPlainObject(node)) {
      const result = {};
      for (const key of Object.keys(node).sort()) {
        if (volatile.has(key)) continue;
        result[key] = walk(node[key]);
      }
      return result;
    }

    return node;
  }

  return walk(value);
}

/** Flattens a normalized realm into `path -> scalar`. Empty containers keep a leaf of their own. */
export function flatten(node, prefix = "", into = new Map()) {
  if (Array.isArray(node)) {
    if (node.length === 0) into.set(prefix, "[]");
    else node.forEach((element, index) => flatten(element, joinPath(prefix, index), into));
  } else if (isPlainObject(node)) {
    const keys = Object.keys(node);
    if (keys.length === 0) into.set(prefix, "{}");
    else for (const key of keys) flatten(node[key], joinPath(prefix, key), into);
  } else {
    into.set(prefix, node);
  }
  return into;
}

/**
 * Compares two normalized realms leaf by leaf.
 *
 * Each finding is one of `changed` (both sides have a value and they differ), `devOnly` (only the
 * development realm has the leaf) or `productionOnly`.
 */
export function diffRealms(devRealm, productionRealm) {
  const dev = flatten(devRealm);
  const production = flatten(productionRealm);
  const findings = [];

  for (const [path, devValue] of dev) {
    if (!production.has(path)) {
      findings.push({ path, kind: "devOnly", dev: devValue });
    } else if (!Object.is(devValue, production.get(path))) {
      findings.push({ path, kind: "changed", dev: devValue, production: production.get(path) });
    }
  }
  for (const [path, productionValue] of production) {
    if (!dev.has(path)) {
      findings.push({ path, kind: "productionOnly", production: productionValue });
    }
  }

  return findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Marks an import-time substitution such as `$(env:QUORUM_PUBLIC_URL)/*`. */
const SUBSTITUTION_PATTERN = /\$\(env:[A-Z0-9_]+\)/;

function collectLeaves(realm, prefix) {
  const leaves = [];
  for (const [path, value] of flatten(realm)) {
    if (isUnder(path, prefix)) leaves.push({ path, value });
  }
  return leaves;
}

/**
 * Checks every finding against the allow-list.
 *
 * A rule may only excuse the difference it was written for, and it must excuse at least one:
 * a rule that no longer matches anything is reported too, because a stale allow-list entry is how a
 * guard quietly stops guarding.
 */
export function applyAllowlist(findings, allowlist, { devRealm, productionRealm } = {}) {
  const rules = allowlist.rules ?? [];
  const matchCounts = new Map(rules.map((rule) => [rule, 0]));
  const violations = [];
  const allowedPaths = new Set();

  for (const finding of findings) {
    const rule = rules.find((candidate) => ruleCovers(candidate, finding));
    if (rule) {
      matchCounts.set(rule, matchCounts.get(rule) + 1);
      allowedPaths.add(finding.path);
    } else {
      violations.push({ type: "unexpectedDifference", finding });
    }
  }

  // A substitution rule is about the *shape* of the two sides, not just about their inequality:
  // production must be substituted, development must not be. Verifying that here is what keeps a
  // hard-coded production origin from slipping through under an allowed path.
  if (devRealm && productionRealm) {
    for (const rule of rules) {
      if (rule.kind !== "envSubstitution") continue;
      for (const leaf of collectLeaves(productionRealm, rule.path)) {
        if (typeof leaf.value !== "string" || !SUBSTITUTION_PATTERN.test(leaf.value)) {
          violations.push({
            type: "substitutionExpected",
            path: leaf.path,
            rule,
            value: leaf.value,
          });
        }
      }
      for (const leaf of collectLeaves(devRealm, rule.path)) {
        if (typeof leaf.value === "string" && SUBSTITUTION_PATTERN.test(leaf.value)) {
          violations.push({
            type: "substitutionUnexpected",
            path: leaf.path,
            rule,
            value: leaf.value,
          });
        }
      }
    }
  }

  for (const [rule, count] of matchCounts) {
    if (count === 0) violations.push({ type: "staleRule", rule });
  }

  return { violations, allowedPaths };
}

function ruleCovers(rule, finding) {
  switch (rule.kind) {
    case "devOnly":
      return isUnder(finding.path, rule.path) && finding.kind === "devOnly";
    case "productionOnly":
      return isUnder(finding.path, rule.path) && finding.kind === "productionOnly";
    case "fixedValues":
      return (
        finding.path === rule.path &&
        finding.kind === "changed" &&
        finding.dev === rule.dev &&
        finding.production === rule.production
      );
    case "envSubstitution":
      return isUnder(finding.path, rule.path);
    default:
      return false;
  }
}

/**
 * Renders a realm for the human-readable diff. Any subtree whose every leaf is an allowed
 * difference is left out entirely on both sides, so what remains in the diff is drift and nothing
 * else — the reviewer is not asked to skip past the dev users again on every failure.
 *
 * Returns `null` for a fully allowed subtree; callers treat that as "omit".
 */
export function renderForDiff(node, allowedPaths, path = "", indent = 0) {
  const pad = "  ".repeat(indent);

  if (Array.isArray(node) && node.length > 0) {
    const lines = [];
    node.forEach((element, index) => {
      const child = renderForDiff(element, allowedPaths, joinPath(path, index), indent + 1);
      if (child) lines.push(`${pad}- [${index}]`, ...child);
    });
    return lines.length ? lines : null;
  }

  if (isPlainObject(node) && Object.keys(node).length > 0) {
    const lines = [];
    for (const key of Object.keys(node)) {
      const child = renderForDiff(node[key], allowedPaths, joinPath(path, key), indent + 1);
      if (child) lines.push(`${pad}${key}:`, ...child);
    }
    return lines.length ? lines : null;
  }

  if (allowedPaths.has(path)) return null;
  const empty = Array.isArray(node) ? "[]" : "{}";
  return [`${pad}${typeof node === "object" && node !== null ? empty : JSON.stringify(node)}`];
}

/**
 * A unified diff of two line arrays. Small enough to keep in the repo and it saves a dependency in
 * a check whose whole point is to stay fast.
 */
export function unifiedDiff(leftLines, rightLines, { leftLabel, rightLabel, context = 3 } = {}) {
  const table = lcsTable(leftLines, rightLines);
  const ops = backtrack(table, leftLines, rightLines);

  const interesting = ops.map((op) => op.type !== "same");
  const keep = ops.map((_, index) =>
    interesting.slice(Math.max(0, index - context), index + context + 1).some(Boolean),
  );
  if (!keep.some(Boolean)) return [];

  const out = [`--- ${leftLabel}`, `+++ ${rightLabel}`];
  let previousKept = false;
  for (const [index, op] of ops.entries()) {
    if (!keep[index]) {
      previousKept = false;
      continue;
    }
    if (!previousKept && out.length > 2) out.push("@@");
    previousKept = true;
    out.push(`${op.type === "same" ? " " : op.type === "remove" ? "-" : "+"}${op.line}`);
  }
  return out;
}

function lcsTable(left, right) {
  const table = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i][j] =
        left[i] === right[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

function backtrack(table, left, right) {
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      ops.push({ type: "same", line: left[i] });
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ type: "remove", line: left[i] });
      i += 1;
    } else {
      ops.push({ type: "add", line: right[j] });
      j += 1;
    }
  }
  while (i < left.length) ops.push({ type: "remove", line: left[i++] });
  while (j < right.length) ops.push({ type: "add", line: right[j++] });
  return ops;
}

/** Runs the whole comparison. Returns `{ ok, violations, diff }`. */
export function checkRealmDrift(devRaw, productionRaw, allowlist, labels = {}) {
  const volatileFields = allowlist.volatileFields ?? [];
  const devRealm = normalizeRealm(devRaw, volatileFields);
  const productionRealm = normalizeRealm(productionRaw, volatileFields);

  const findings = diffRealms(devRealm, productionRealm);
  const { violations, allowedPaths } = applyAllowlist(findings, allowlist, {
    devRealm,
    productionRealm,
  });

  const diff = violations.length
    ? unifiedDiff(
        renderForDiff(devRealm, allowedPaths) ?? [],
        renderForDiff(productionRealm, allowedPaths) ?? [],
        {
          leftLabel: labels.dev ?? "development realm (normalized)",
          rightLabel: labels.production ?? "production realm (normalized)",
        },
      )
    : [];

  return { ok: violations.length === 0, findings, violations, diff };
}
