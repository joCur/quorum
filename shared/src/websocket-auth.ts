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
 * The subprotocol list a client offers for `new WebSocket(url, protocols)`. The token follows
 * the marker, which is the order {@link readBearerSubprotocolToken} reads them back in.
 */
export function bearerSubprotocolOffer(token: string): [string, string] {
  return [BEARER_SUBPROTOCOL, token];
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

  const token = offered[markerIndex + 1];
  // A repeated marker is not a token; treating it as one would let an empty offer authenticate.
  return token === BEARER_SUBPROTOCOL ? undefined : token;
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
