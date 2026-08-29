/**
 * Object key layout — tenant and user scoped (ADR-001).
 *
 *   tenants/<tenantId>/users/<userId>/sessions/<sessionId>/session.json
 *   tenants/<tenantId>/users/<userId>/sessions/<sessionId>/chunks/<seq:010d>.bin
 *   tenants/<tenantId>/users/<userId>/sessions/<sessionId>/manifest.json
 *
 * A zero-padded sequence number keeps lexicographic listing order identical to
 * numeric order, which is what makes recovery after a server crash cheap: list
 * the chunk prefix and the highest contiguous sequence is `persistedSeq`.
 */

export interface KeyScope {
  tenantId: string;
  userId: string;
  sessionId: string;
}

export const SEQ_DIGITS = 10;

export function sessionPrefix(scope: KeyScope): string {
  return `tenants/${scope.tenantId}/users/${scope.userId}/sessions/${scope.sessionId}`;
}

export function sessionKey(scope: KeyScope): string {
  return `${sessionPrefix(scope)}/session.json`;
}

export function chunkPrefix(scope: KeyScope): string {
  return `${sessionPrefix(scope)}/chunks/`;
}

export function chunkKey(scope: KeyScope, seq: number): string {
  return `${chunkPrefix(scope)}${String(seq).padStart(SEQ_DIGITS, "0")}.bin`;
}

export function manifestKey(scope: KeyScope): string {
  return `${sessionPrefix(scope)}/manifest.json`;
}

export function seqFromChunkKey(key: string): number | null {
  const match = /\/chunks\/(\d+)\.bin$/.exec(key);
  if (!match) return null;
  const seq = Number.parseInt(match[1] as string, 10);
  return Number.isSafeInteger(seq) ? seq : null;
}
