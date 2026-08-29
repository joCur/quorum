import {
  BEARER_SUBPROTOCOL,
  offersBearerSubprotocol,
  readBearerSubprotocolToken,
} from "@quorum/shared";
import { AuthError } from "./errors.js";

// The marker, the offer order and the server's selection rule are the wire contract, so they live
// in @quorum/shared and the client offers exactly what the server reads. What stays here is the
// server-side reading of the failure cases as `AuthError`s.
export {
  BEARER_SUBPROTOCOL,
  offersBearerSubprotocol,
  selectBearerSubprotocol,
} from "@quorum/shared";

/**
 * Extracts the raw token from the offered subprotocols. The token is the entry directly following
 * the {@link BEARER_SUBPROTOCOL} marker, mirroring the order the client sends them in.
 */
export function extractSubprotocolToken(header: string | string[] | undefined): string {
  if (!offersBearerSubprotocol(header)) {
    throw new AuthError("missing_token", "No access token was provided.");
  }

  const token = readBearerSubprotocolToken(header);
  if (token === undefined) {
    throw new AuthError(
      "malformed_bearer_subprotocol",
      `The "${BEARER_SUBPROTOCOL}" subprotocol must be followed by the access token.`,
    );
  }
  return token;
}
