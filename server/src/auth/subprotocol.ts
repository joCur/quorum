import { AuthError } from "./errors.js";

/**
 * Subprotocol that carries the bearer token through a WebSocket handshake.
 *
 * Browsers cannot set an `Authorization` header on a WebSocket upgrade, and a query parameter
 * would end up in access logs and proxy history. `Sec-WebSocket-Protocol` is the remaining
 * request-scoped channel: the client offers `[<marker>, <token>]` and the server echoes the
 * marker back, as RFC 6455 requires the selected subprotocol to be one of the offered ones.
 */
export const BEARER_SUBPROTOCOL = "quorum.bearer.v1";

/** Splits a `Sec-WebSocket-Protocol` header into its individual, trimmed entries. */
function parseOfferedProtocols(header: string): string[] {
  return header
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Extracts the raw token from the offered subprotocols. The token is the entry directly following
 * the {@link BEARER_SUBPROTOCOL} marker, mirroring the order the client sends them in.
 */
export function extractSubprotocolToken(header: string | string[] | undefined): string {
  if (header === undefined) {
    throw new AuthError("missing_token", "No access token was provided.");
  }

  const offered = parseOfferedProtocols(Array.isArray(header) ? header.join(",") : header);
  const markerIndex = offered.indexOf(BEARER_SUBPROTOCOL);
  if (markerIndex === -1) {
    throw new AuthError("missing_token", "No access token was provided.");
  }

  const token = offered[markerIndex + 1];
  if (token === undefined || token === BEARER_SUBPROTOCOL) {
    throw new AuthError(
      "malformed_bearer_subprotocol",
      `The "${BEARER_SUBPROTOCOL}" subprotocol must be followed by the access token.`,
    );
  }
  return token;
}

/** True when the offered subprotocols carry a bearer token. */
export function offersBearerSubprotocol(header: string | string[] | undefined): boolean {
  if (header === undefined) return false;
  const value = Array.isArray(header) ? header.join(",") : header;
  return parseOfferedProtocols(value).includes(BEARER_SUBPROTOCOL);
}

/**
 * Subprotocol selection for the `ws` server. RFC 6455 lets the server pick at most one of the
 * offered subprotocols; picking the marker (never the token, which must not be echoed) keeps the
 * browser from aborting the connection. Returning `false` means "no subprotocol", which is the
 * correct answer for a client that offered none of ours.
 */
export function selectBearerSubprotocol(protocols: Set<string>): string | false {
  return protocols.has(BEARER_SUBPROTOCOL) ? BEARER_SUBPROTOCOL : false;
}
