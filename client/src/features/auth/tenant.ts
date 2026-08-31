/**
 * What the access token in hand says about the tenant.
 *
 * This is a routing decision, not a security one. The server decides what a token may do and
 * refuses one without a tenant; reading the claim here only spares the app a round trip on every
 * load to learn something the token already says.
 *
 * The three-way answer is what matters. "No tenant" and "cannot read this at all" look the same
 * from a boolean and are entirely different situations: the first is a newly registered account
 * that needs its workspace, the second is a token that expired, was replaced or was never a token
 * — and that belongs to the sign-in machinery, which already knows how to renew a session and
 * how to say "your session ended". Collapsing the two sends an expired session into a workspace
 * setup screen it can never leave.
 */
export type TenantClaimState =
  /** The token names a tenant. Nothing to do. */
  | "present"
  /** A readable token with no tenant claim: an account that has not been set up yet. */
  | "absent"
  /** Missing, malformed, or not a JWT. Whatever is wrong, provisioning is not the answer. */
  | "unreadable";

export function tenantClaimState(accessToken: string | null): TenantClaimState {
  if (accessToken === null) return "unreadable";

  const payload = accessToken.split(".")[1];
  if (payload === undefined) return "unreadable";

  try {
    const decoded = JSON.parse(base64UrlDecode(payload)) as Record<string, unknown>;
    const tenantId = decoded["tenant_id"];
    return typeof tenantId === "string" && tenantId.length > 0 ? "present" : "absent";
  } catch {
    return "unreadable";
  }
}

function base64UrlDecode(value: string): string {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "=");
  // `atob` yields one character per byte; mapping them into a byte array is what turns those
  // bytes back into the UTF-8 the claim was written in.
  return new TextDecoder().decode(
    Uint8Array.from(atob(padded), (character) => character.charCodeAt(0)),
  );
}
