import { describe, expect, it } from "vitest";
import {
  encodeSubprotocolToken,
  BEARER_SUBPROTOCOL,
  bearerSubprotocolOffer,
  offersBearerSubprotocol,
  parseOfferedProtocols,
  readBearerSubprotocolToken,
  selectBearerSubprotocol,
} from "../src/websocket-auth.js";

describe("bearerSubprotocolOffer", () => {
  it("puts the encoded token directly after the marker", () => {
    // SPIKE: the token is base64url-encoded on the wire. A better-auth session token ends in `=`,
    // which RFC 6455 does not allow in a subprotocol name — browsers and `ws` both refuse the
    // handshake outright, so the encoding is what keeps this channel usable at all.
    const offer = bearerSubprotocolOffer("session-id.c2lnbmF0dXJl=");
    expect(offer[0]).toBe(BEARER_SUBPROTOCOL);
    expect(offer[1]).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(offer[1]).not.toContain("=");
  });

  it("round-trips a credential containing characters the wire format forbids", () => {
    const token = "abc+def/ghi=";
    expect(readBearerSubprotocolToken(bearerSubprotocolOffer(token))).toBe(token);
  });

  it("produces an offer the reader accepts — the contract both sides rely on", () => {
    const offer = bearerSubprotocolOffer("abc.def.ghi");
    expect(offersBearerSubprotocol(offer)).toBe(true);
    expect(readBearerSubprotocolToken(offer)).toBe("abc.def.ghi");
  });
});

describe("parseOfferedProtocols", () => {
  it("trims entries, drops empty ones and accepts both header shapes", () => {
    expect(parseOfferedProtocols(" a , b ,, c")).toEqual(["a", "b", "c"]);
    expect(parseOfferedProtocols(["a", "b"])).toEqual(["a", "b"]);
    expect(parseOfferedProtocols(undefined)).toEqual([]);
  });
});

describe("readBearerSubprotocolToken", () => {
  it("reads the token behind the marker, wherever the marker sits", () => {
    const encoded = encodeSubprotocolToken("a.b.c");
    expect(readBearerSubprotocolToken(`other.protocol, ${BEARER_SUBPROTOCOL}, ${encoded}`)).toBe(
      "a.b.c",
    );
  });

  it("returns undefined without a marker, and for a marker without a token", () => {
    expect(readBearerSubprotocolToken("other.protocol")).toBeUndefined();
    expect(readBearerSubprotocolToken(BEARER_SUBPROTOCOL)).toBeUndefined();
    // A repeated marker is not a token — otherwise an empty offer would authenticate.
    expect(
      readBearerSubprotocolToken(`${BEARER_SUBPROTOCOL}, ${BEARER_SUBPROTOCOL}`),
    ).toBeUndefined();
  });

  it("returns undefined for an entry that is not valid base64url", () => {
    // The wire is attacker-controlled; anything that is not decodable is simply not a credential.
    expect(
      readBearerSubprotocolToken(`${BEARER_SUBPROTOCOL}, not*valid*base64url`),
    ).toBeUndefined();
  });
});

describe("selectBearerSubprotocol", () => {
  it("echoes the marker and never the token", () => {
    expect(selectBearerSubprotocol(new Set([BEARER_SUBPROTOCOL, "the-token"]))).toBe(
      BEARER_SUBPROTOCOL,
    );
  });

  it("selects no subprotocol when ours was not offered", () => {
    expect(selectBearerSubprotocol(new Set(["other.protocol"]))).toBe(false);
  });
});
