import {
  expect,
  startRecording,
  stopRecording,
  test,
  waitFor,
  watchRecordingProtocol,
} from "../fixtures.js";
import { devUsers } from "../support/env.js";
import { fetchToken } from "../support/keycloak.js";
import { startApi, stopApi } from "../support/stack.js";
import { chunkSeqs, readManifest } from "../support/storage.js";

/**
 * Critical path: crash recovery — reconnect from `persistedSeq`, local buffer (CLAUDE.md).
 *
 * The API is killed mid-recording while capture keeps running. What has to hold: the user is told
 * what is buffered and that it is safe, capture never stops, and once the server is back every
 * chunk arrives exactly once and in order. The last part is asserted against object storage,
 * because a gap-free sequence there is the property the whole protocol exists to guarantee — the
 * server rebuilds its session state from those objects, nothing else.
 */

test.afterAll(async () => {
  // A test that fails between the stop and the start must not take the rest of the run with it.
  await startApi();
});

test("survives the server dying mid-recording", async ({ page, signIn }) => {
  const alice = await fetchToken(devUsers.alice);
  const protocol = watchRecordingProtocol(page);

  await signIn(devUsers.alice);
  await page.goto("/record");
  await startRecording(page);

  const sessionId = await protocol.waitForSessionId();
  await protocol.waitForAck(2);
  const scope = { tenantId: alice.tenantId, userId: alice.userId, sessionId };
  const seqsBeforeOutage = await chunkSeqs(scope);
  expect(seqsBeforeOutage.length).toBeGreaterThan(0);

  const ackedBeforeOutage = protocol.persistedSeq;

  // The crash. The open WebSocket dies with the process, and so does every bit of session state
  // the server was holding in memory.
  await stopApi();

  // The user is told, and told what is safe: the banner names the buffered duration.
  const banner = page.getByRole("status").filter({ hasText: /buffered/ });
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(banner).toContainText(/\d+s buffered/);

  // Capture does not stop while the server is gone.
  const elapsed = page.locator("main p.font-mono").first();
  const duringOutage = await elapsed.innerText();
  await waitFor(
    async () => (await elapsed.innerText()) !== duringOutage,
    20_000,
    "the timer to keep running during the outage",
  );

  await startApi();

  // Reconnect, resume from `persistedSeq` — which the server recomputed by listing the chunk
  // objects — and deliver everything that piled up locally.
  await protocol.waitForAck(ackedBeforeOutage + 3, 90_000);
  await expect(banner).toBeHidden({ timeout: 30_000 });

  await stopRecording(page);
  await protocol.waitForFinalized(60_000);

  // The decisive assertion: server-side object continuity. Every sequence number from 0 to the
  // last one is present exactly once — the outage left no hole and no duplicate.
  const seqs = await chunkSeqs(scope);
  expect(seqs.length).toBeGreaterThan(seqsBeforeOutage.length);
  expect(seqs).toEqual(seqs.map((_value, index) => index));
  expect(new Set(seqs).size).toBe(seqs.length);

  const manifest = await readManifest(scope);
  expect(manifest?.persistedSeq).toBe(seqs.length - 1);
  expect(manifest?.chunkCount).toBe(seqs.length);
});
