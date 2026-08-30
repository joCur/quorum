import { describe, expect, it } from "vitest";
import type { AuthError } from "../src/auth/errors.js";
import { encodeSubprotocolToken } from "@quorum/shared";
import {
  BEARER_SUBPROTOCOL,
  extractSubprotocolToken,
  offersBearerSubprotocol,
  selectBearerSubprotocol,
} from "../src/auth/subprotocol.js";

/**
 * SPIKE: the token now travels base64url-encoded, because a better-auth session token contains
 * `=` and RFC 6455 subprotocol names may not. The encoding is part of the shared wire contract
 * (`shared/src/websocket-auth.ts`), so it is exercised here rather than stubbed.
 */
const encoded = encodeSubprotocolToken("session-id.c2lnbmF0dXJl=");

describe("extractSubprotocolToken", () => {
  it("takes the entry following the bearer marker", () => {
    expect(extractSubprotocolToken(`${BEARER_SUBPROTOCOL}, ${encoded}`)).toBe(
      "session-id.c2lnbmF0dXJl=",
    );
  });

  it("tolerates missing whitespace and joins a repeated header", () => {
    expect(extractSubprotocolToken(`${BEARER_SUBPROTOCOL},${encoded}`)).toBe(
      "session-id.c2lnbmF0dXJl=",
    );
    expect(extractSubprotocolToken([BEARER_SUBPROTOCOL, encoded])).toBe("session-id.c2lnbmF0dXJl=");
  });

  it("ignores unrelated subprotocols offered before the marker", () => {
    expect(extractSubprotocolToken(`some.other.protocol, ${BEARER_SUBPROTOCOL}, ${encoded}`)).toBe(
      "session-id.c2lnbmF0dXJl=",
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

describe("encodeSubprotocolToken", () => {
  it("produces only characters RFC 6455 allows in a subprotocol name", () => {
    // The exact reason the encoding exists: the raw token is rejected by both the browser and
    // `ws` before the request ever reaches the server.
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
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
