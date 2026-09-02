import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = resolve(dirname(fileURLToPath(import.meta.url)), "minio-init.sh");

/**
 * A stand-in for `mc` that parses its arguments the way the real one does: everything before `--`
 * that starts with a hyphen is a flag, and an unknown flag is fatal. That is the whole bug — a
 * password beginning with "-" arrives as a positional argument and is read as a flag — so the stub
 * has to reproduce the parsing rather than just record the call, or the test would pass with the
 * fix reverted.
 */
const STUB_MC = `#!/bin/sh
printf '%s\\n' "$*" >> "$MC_CALLS"
seen_terminator=0
for argument in "$@"; do
  if [ "$argument" = "--" ]; then
    seen_terminator=1
    continue
  fi
  [ "$seen_terminator" -eq 1 ] && continue
  case "$argument" in
    --ignore-existing) ;;
    -*)
      echo "mc: <ERROR> flag provided but not defined: $argument" >&2
      exit 1
      ;;
  esac
done
exit 0
`;

let workspace;

beforeEach(() => {
  workspace = mkdtempSync(resolve(tmpdir(), "minio-init-"));
  writeFileSync(resolve(workspace, "mc"), STUB_MC, { mode: 0o755 });
});

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function runBootstrap(password) {
  const calls = resolve(workspace, "calls.txt");
  writeFileSync(calls, "");
  const result = spawnSync("sh", [script], {
    encoding: "utf8",
    env: {
      PATH: `${workspace}:${process.env["PATH"]}`,
      MC_CALLS: calls,
      MINIO_ENDPOINT: "http://minio:9000",
      MINIO_ROOT_USER: "quorum",
      MINIO_ROOT_PASSWORD: password,
      S3_BUCKET: "recordings",
      // The retry window only has to be short enough that a failing run ends inside the test's
      // patience; the attempt floor still gives every step several tries.
      MINIO_INIT_RETRY_WINDOW_SECONDS: "0",
    },
  });
  return { ...result, calls: readFileSync(calls, "utf8").trim().split("\n").filter(Boolean) };
}

describe("the bucket bootstrap", () => {
  it("passes a password that begins with a hyphen through as a credential", () => {
    const password = "-0R4Ffvxyz123ABCdefGHI456";

    const { status, stderr, calls } = runBootstrap(password);

    expect(stderr).not.toContain("flag provided but not defined");
    expect(status).toBe(0);
    expect(calls[0]).toBe(`alias set -- quorum http://minio:9000 quorum ${password}`);
  });

  it("still bootstraps an ordinary password", () => {
    const { status, calls } = runBootstrap("ordinaryPassword123");

    expect(status).toBe(0);
    expect(calls).toHaveLength(4);
  });

  it("names credential parsing when a value really is read as a flag", () => {
    // The bucket reaches mc as `quorum/<name>`, so it can only be misparsed if mc is invoked
    // without the terminator — which is exactly what this message has to explain when it happens.
    const { status, stderr } = runBootstrap("-fine-now");
    expect(status).toBe(0);

    const brokenStub = STUB_MC.replace('if [ "$argument" = "--" ]', 'if [ "$argument" = "#" ]');
    writeFileSync(resolve(workspace, "mc"), brokenStub, { mode: 0o755 });
    const reverted = runBootstrap("-0R4Ffvxyz123ABCdefGHI456");

    expect(reverted.status).toBe(1);
    expect(reverted.stderr).toContain("flag provided but not defined");
    expect(reverted.stderr).toContain("parsed as a command-line flag");
    expect(reverted.stderr).toContain("MINIO_ROOT_PASSWORD");
    expect(stderr).not.toContain("parsed as a command-line flag");
  });
});
