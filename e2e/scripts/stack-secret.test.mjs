import { describe, expect, it, vi } from "vitest";

import { flagLikeSecrets, stackSecret } from "./stack-secret.mjs";

const randomBytesMock = vi.hoisted(() => vi.fn());
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal();
  randomBytesMock.mockImplementation(actual.randomBytes);
  return { ...actual, randomBytes: randomBytesMock };
});

// base64url encodes the first six bits of the first byte, and 0b111110 is "-", so any byte in
// 0xf8..0xfb starts a value with the character that breaks the bootstrap.
const startsWithHyphen = Buffer.alloc(24, 0xf8);
const startsWithLetter = Buffer.alloc(24, 0x00);

describe("stackSecret", () => {
  it("never returns a value a tool could read as a flag", () => {
    // The rejected draw is one in twenty-two, so this many draws makes a regression to plain
    // base64url a certainty rather than a coin toss.
    for (let i = 0; i < 5_000; i += 1) {
      expect(stackSecret()).toMatch(/^[A-Za-z0-9]/);
    }
  });

  it("draws again instead of patching a value that begins with a hyphen", () => {
    randomBytesMock.mockReturnValueOnce(startsWithHyphen).mockReturnValueOnce(startsWithLetter);

    // The second draw is returned whole: a first character rewritten in place would be a biased
    // character, and the rest of the discarded value never reaches the caller either.
    expect(stackSecret()).toBe(startsWithLetter.toString("base64url"));
  });

  it("keeps the requested number of random bytes", () => {
    expect(Buffer.from(stackSecret(32), "base64url")).toHaveLength(32);
  });
});

describe("flagLikeSecrets", () => {
  it("names every value that begins with a hyphen", () => {
    const found = flagLikeSecrets({
      POSTGRES_PASSWORD: "-leading",
      MINIO_ROOT_PASSWORD: "safe",
      KEYCLOAK_DB_PASSWORD: "-also-leading",
    });

    expect(found).toEqual(["POSTGRES_PASSWORD", "KEYCLOAK_DB_PASSWORD"]);
  });

  it("finds nothing in a file this harness generated", () => {
    const generated = {
      POSTGRES_PASSWORD: stackSecret(),
      MINIO_ROOT_PASSWORD: stackSecret(),
    };

    expect(flagLikeSecrets(generated)).toEqual([]);
  });
});
