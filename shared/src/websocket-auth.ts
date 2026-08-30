/**
 * Bearer token transport for the WebSocket handshake — the one definition both sides use.
 *
 * Browsers cannot set an `Authorization` header on a WebSocket upgrade, and a query parameter
 * would end up in access logs and proxy history. `Sec-WebSocket-Protocol` is the remaining
 * request-scoped channel: the client offers `[<marker>, <token>]` and the server echoes the
 * marker back, as RFC 6455 requires the selected subprotocol to be one of the offered ones.
 *
 * The marker and the offer order are a wire contract, so they live here rather than being
 * spelled out once per package.
 */

/** Subprotocol marker that announces a bearer token in the handshake. */
export const BEARER_SUBPROTOCOL = "quorum.bearer.v1";

/**
 * SPIKE: the credential is base64url-encoded before it goes on the wire.
 *
 * RFC 6455 subprotocol names are HTTP tokens, so the alphabet is restricted. A Keycloak access
 * token was already inside it — a JWT is base64url with dots — so this encoding did not exist.
 * A better-auth session token is `<id>.<base64 signature>`, and standard base64 contains `=`,
 * which browsers and `ws` both reject outright with "an invalid subprotocol was specified".
 *
 * The alternative was to send only the unsigned half of the token, which better-auth accepts
 * (`bearer({ requireSignature: false })`). That would have thrown away the signature check on the
 * one channel where the credential travels in the clear-text handshake, so the encoding is the
 * better trade: it keeps the full, signed credential and stays inside the allowed alphabet.
 */
export function bearerSubprotocolOffer(token: string): [string, string] {
  return [BEARER_SUBPROTOCOL, encodeSubprotocolToken(token)];
}

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Base64url without padding — every character is a legal subprotocol character.
 *
 * Written out rather than delegated to `btoa` or `Buffer`, because this module is imported by the
 * browser client, the Node server and the tests alike, and `shared` deliberately declares neither
 * the DOM nor the Node type libraries.
 */
export function encodeSubprotocolToken(token: string): string {
  let output = "";
  for (let index = 0; index < token.length; index += 3) {
    const a = token.charCodeAt(index) & 0xff;
    const hasB = index + 1 < token.length;
    const hasC = index + 2 < token.length;
    const b = hasB ? token.charCodeAt(index + 1) & 0xff : 0;
    const c = hasC ? token.charCodeAt(index + 2) & 0xff : 0;

    output += BASE64URL_ALPHABET[a >> 2];
    output += BASE64URL_ALPHABET[((a & 0x03) << 4) | (b >> 4)];
    if (hasB) output += BASE64URL_ALPHABET[((b & 0x0f) << 2) | (c >> 6)];
    if (hasC) output += BASE64URL_ALPHABET[c & 0x3f];
  }
  return output;
}

/** Inverse of {@link encodeSubprotocolToken}. Returns `undefined` for anything undecodable. */
export function decodeSubprotocolToken(value: string): string | undefined {
  let buffer = 0;
  let bits = 0;
  let output = "";
  for (const character of value) {
    const digit = BASE64URL_ALPHABET.indexOf(character);
    if (digit === -1) return undefined;
    buffer = (buffer << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      output += String.fromCharCode((buffer >> bits) & 0xff);
    }
  }
  return output.length > 0 ? output : undefined;
}

/** Splits a `Sec-WebSocket-Protocol` header into its individual, trimmed entries. */
export function parseOfferedProtocols(header: string | string[] | undefined): string[] {
  if (header === undefined) return [];
  return (Array.isArray(header) ? header.join(",") : header)
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/** True when the offered subprotocols announce a bearer token. */
export function offersBearerSubprotocol(header: string | string[] | undefined): boolean {
  return parseOfferedProtocols(header).includes(BEARER_SUBPROTOCOL);
}

/**
 * The raw token from the offered subprotocols: the entry directly following the marker.
 *
 * Returns `undefined` both when no marker was offered and when it was offered without a token
 * following it — the two cases are told apart with {@link offersBearerSubprotocol}, so that
 * each side can map them onto its own error handling rather than a shared exception type.
 */
export function readBearerSubprotocolToken(
  header: string | string[] | undefined,
): string | undefined {
  const offered = parseOfferedProtocols(header);
  const markerIndex = offered.indexOf(BEARER_SUBPROTOCOL);
  if (markerIndex === -1) return undefined;

  const encoded = offered[markerIndex + 1];
  // A repeated marker is not a token; treating it as one would let an empty offer authenticate.
  if (encoded === undefined || encoded === BEARER_SUBPROTOCOL) return undefined;
  return decodeSubprotocolToken(encoded);
}

/**
 * Subprotocol selection for the server side of the handshake. RFC 6455 lets the server pick at
 * most one of the offered subprotocols; picking the marker (never the token, which must not be
 * echoed) keeps the browser from aborting the connection. `false` means "no subprotocol", the
 * correct answer for a client that offered none of ours.
 */
export function selectBearerSubprotocol(protocols: Set<string>): string | false {
  return protocols.has(BEARER_SUBPROTOCOL) ? BEARER_SUBPROTOCOL : false;
}
