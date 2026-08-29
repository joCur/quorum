import { describe, expect, it } from "vitest";
import {
  BEARER_SUBPROTOCOL,
  bearerSubprotocolOffer,
  offersBearerSubprotocol,
  parseOfferedProtocols,
  readBearerSubprotocolToken,
  selectBearerSubprotocol,
} from "../src/websocket-auth.js";

describe("bearerSubprotocolOffer", () => {
  it("puts the token directly after the marker", () => {
    expect(bearerSubprotocolOffer("header.payload.signature")).toEqual([
      BEARER_SUBPROTOCOL,
      "header.payload.signature",
    ]);
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
    expect(readBearerSubprotocolToken(`other.protocol, ${BEARER_SUBPROTOCOL}, a.b.c`)).toBe(
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
