import { describe, expect, it } from "vitest";
import { LIMIT_ERROR_CODES } from "@quorum/shared";
import enMessages from "@/i18n/locales/en.json";
import deMessages from "@/i18n/locales/de.json";
import {
  asLimitCode,
  isRecordingFinalizedDespite,
  limitMessageKey,
} from "@/features/limits/messages";

/** Reads a dotted i18n key out of a locale bundle. */
function lookup(bundle: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], bundle);
}

describe("limit codes", () => {
  it("recognizes every code the server can send, and nothing else", () => {
    for (const code of LIMIT_ERROR_CODES) expect(asLimitCode(code)).toBe(code);
    expect(asLimitCode("session finalized")).toBeNull();
    expect(asLimitCode("unauthorized")).toBeNull();
    expect(asLimitCode("limit.")).toBeNull();
    expect(asLimitCode(undefined)).toBeNull();
  });

  it("has copy in both languages for every limit — a code with no message is a generic failure", () => {
    for (const code of LIMIT_ERROR_CODES) {
      const key = limitMessageKey(code);
      expect(typeof lookup(enMessages, key), `${code} in en`).toBe("string");
      expect(typeof lookup(deMessages, key), `${code} in de`).toBe("string");
    }
  });

  it("only calls the recording safe for the limits that finalize it", () => {
    // The three duration limits finalize what the server already holds — recorded audio, session
    // lifetime, and a pause that outlasted its allowance. Every other limit refuses, and telling
    // the user their recording is safe there would be a lie.
    const finalizing: readonly string[] = [
      "limit.session_duration_exceeded",
      "limit.session_lifetime_exceeded",
      "limit.pause_duration_exceeded",
    ];
    for (const code of LIMIT_ERROR_CODES) {
      expect(isRecordingFinalizedDespite(code), code).toBe(finalizing.includes(code));
    }
    expect(LIMIT_ERROR_CODES.filter((code) => finalizing.includes(code))).toHaveLength(3);
  });
});
