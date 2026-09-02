/**
 * Object key layout the recording endpoint writes and this worker reads
 * (ADR-001 tenant/user scoping):
 *
 *   tenants/<tenantId>/users/<userId>/sessions/<sessionId>/session.json
 *   tenants/<tenantId>/users/<userId>/sessions/<sessionId>/chunks/<seq:010d>.bin
 *   tenants/<tenantId>/users/<userId>/sessions/<sessionId>/manifest.json
 *   tenants/<tenantId>/users/<userId>/sessions/<sessionId>/audio.webm
 *
 * NOTE ON DUPLICATION: the API server carries an identical copy of these
 * helpers. They are duplicated on purpose for now — extracting them would mean
 * editing the server package while its auth rework is in flight. The layout is
 * covered by tests on both sides; a later ticket should move them into a shared
 * storage package, at which point both copies are deleted in one change.
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
 */
export function audioKey(scope: KeyScope): string {
  return `${sessionPrefix(scope)}/audio.webm`;
}

/**
 * Where one run writes the repackaged file before it has been read back and checked.
 *
 * Two things are going on in this name. The staging suffix is what makes "verify, then delete"
 * observable from outside: playback and the worker key off `audioKey` alone, so a half-written or
 * unverified artifact can never be served — it does not carry that name until it has passed.
 *
 * The run id is what keeps two jobs out of each other's way. The queue can hand out the same
 * repackaging twice (see the note in the remux enqueuer), and a shared staging name would let one
 * run delete the object the other is about to read back. Each run therefore owns its staging
 * object and removes it whatever happens, so the two never touch the same key.
 */
export function stagingAudioKey(scope: KeyScope, runId: string): string {
  return `${sessionPrefix(scope)}/audio.webm.staging.${runId}`;
}
