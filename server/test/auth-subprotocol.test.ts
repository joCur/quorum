import { describe, expect, it } from "vitest";
import type { AuthError } from "../src/auth/errors.js";
import {
  BEARER_SUBPROTOCOL,
  extractSubprotocolToken,
  offersBearerSubprotocol,
  selectBearerSubprotocol,
} from "../src/auth/subprotocol.js";

describe("extractSubprotocolToken", () => {
  it("takes the entry following the bearer marker", () => {
    expect(extractSubprotocolToken(`${BEARER_SUBPROTOCOL}, header.payload.signature`)).toBe(
      "header.payload.signature",
    );
  });

  it("tolerates missing whitespace and joins a repeated header", () => {
    expect(extractSubprotocolToken(`${BEARER_SUBPROTOCOL},abc.def.ghi`)).toBe("abc.def.ghi");
    expect(extractSubprotocolToken([BEARER_SUBPROTOCOL, "abc.def.ghi"])).toBe("abc.def.ghi");
  });

  it("ignores unrelated subprotocols offered before the marker", () => {
    expect(extractSubprotocolToken(`some.other.protocol, ${BEARER_SUBPROTOCOL}, token`)).toBe(
      "token",
    );
  });

  it("rejects a missing header", () => {
    expect(() => extractSubprotocolToken(undefined)).toThrow(
      expect.objectContaining({ code: "missing_token" }) as AuthError,
    );
  });

  it("rejects a header without the bearer marker", () => {
    expect(() => extractSubprotocolToken("some.other.protocol")).toThrow(
      expect.objectContaining({ code: "missing_token" }) as AuthError,
    );
  });

  it("rejects a marker that is not followed by a token", () => {
    expect(() => extractSubprotocolToken(BEARER_SUBPROTOCOL)).toThrow(
      expect.objectContaining({ code: "malformed_bearer_subprotocol" }) as AuthError,
    );
    expect(() => extractSubprotocolToken(`${BEARER_SUBPROTOCOL}, ${BEARER_SUBPROTOCOL}`)).toThrow(
      expect.objectContaining({ code: "malformed_bearer_subprotocol" }) as AuthError,
    );
  });
});

describe("offersBearerSubprotocol", () => {
  it("detects the marker and nothing else", () => {
    expect(offersBearerSubprotocol(`${BEARER_SUBPROTOCOL}, token`)).toBe(true);
    expect(offersBearerSubprotocol("some.other.protocol")).toBe(false);
    expect(offersBearerSubprotocol(undefined)).toBe(false);
  });
});

describe("selectBearerSubprotocol", () => {
  it("echoes the marker but never the token", () => {
    expect(selectBearerSubprotocol(new Set([BEARER_SUBPROTOCOL, "the-token"]))).toBe(
      BEARER_SUBPROTOCOL,
    );
  });

  it("selects no subprotocol when the client offered none of ours", () => {
    expect(selectBearerSubprotocol(new Set(["some.other.protocol"]))).toBe(false);
  });
});
