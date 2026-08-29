import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import type { CryptoKey, JWK, JWTVerifyGetKey } from "jose";

export const ISSUER = "http://localhost:8081/realms/quorum";
export const INTERNAL_ISSUER = "http://keycloak:8080/realms/quorum";
export const AUDIENCE = "quorum-api";
const ALGORITHM = "RS256";

export interface TestKeyPair {
  readonly privateKey: CryptoKey;
  readonly publicJwk: JWK;
  readonly keyId: string;
  readonly jwks: JWTVerifyGetKey;
}

/**
 * Generates an RSA key pair and a local JWKS resolver for it. Everything happens in-process, so
 * the auth tests never touch the network or a running Keycloak.
 */
export async function createTestKeyPair(keyId = "test-key"): Promise<TestKeyPair> {
  const { privateKey, publicKey } = await generateKeyPair(ALGORITHM, { extractable: true });
  const publicJwk: JWK = {
    ...(await exportJWK(publicKey)),
    kid: keyId,
    alg: ALGORITHM,
    use: "sig",
  };
  return {
    privateKey,
    publicJwk,
    keyId,
    jwks: createLocalJWKSet({ keys: [publicJwk] }),
  };
}

export interface TokenOverrides {
  readonly issuer?: string;
  readonly audience?: string | string[];
  readonly subject?: string;
  readonly tenantId?: string | null;
  readonly roles?: string[];
  readonly issuedAt?: number;
  readonly expiresAt?: number;
  readonly username?: string;
  readonly email?: string;
}

/** Signs an access token that looks like the one the `quorum` realm issues. */
export async function signAccessToken(
  keys: TestKeyPair,
  overrides: TokenOverrides = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const payload: Record<string, unknown> = {
    preferred_username: overrides.username ?? "dev.alice",
    email: overrides.email ?? "alice@acme.dev.invalid",
    realm_access: { roles: overrides.roles ?? ["quorum-user"] },
  };
  if (overrides.tenantId !== null) {
    payload["tenant_id"] = overrides.tenantId ?? "tenant-acme";
  }

  return new SignJWT(payload)
    .setProtectedHeader({ alg: ALGORITHM, kid: keys.keyId, typ: "JWT" })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setSubject(overrides.subject ?? "11111111-1111-4111-8111-111111111111")
    .setIssuedAt(overrides.issuedAt ?? now)
    .setExpirationTime(overrides.expiresAt ?? now + 300)
    .sign(keys.privateKey);
}
