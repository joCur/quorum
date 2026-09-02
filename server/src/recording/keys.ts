/**
 * Object key layout — tenant and user scoped (ADR-001).
 *
 *   tenants/<tenantId>/users/<userId>/sessions/<sessionId>/session.json
 *   tenants/<tenantId>/users/<userId>/sessions/<sessionId>/chunks/<seq:010d>.bin
 *   tenants/<tenantId>/users/<userId>/sessions/<sessionId>/manifest.json
 *   tenants/<tenantId>/users/<userId>/sessions/<sessionId>/audio.webm
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

/**
 * The seekable file a finalized recording is repackaged into (ADR-010).
 *
 * It replaces the chunk objects rather than joining them: once this key exists, the recording
 * is one object, and the chunk prefix is empty.
 *
 * The pipeline stages the file under a longer name and only copies it to this one after reading
 * it back, so an object carrying exactly this key is one that has already been checked. That is
 * what lets playback decide from a listing alone — and why it must match the key exactly rather
 * than by prefix.
 */
export function audioKey(scope: KeyScope): string {
  return `${sessionPrefix(scope)}/audio.webm`;
}

export function seqFromChunkKey(key: string): number | null {
  const match = /\/chunks\/(\d+)\.bin$/.exec(key);
  if (!match) return null;
  const seq = Number.parseInt(match[1] as string, 10);
  return Number.isSafeInteger(seq) ? seq : null;
}
