import {
  bufferedChunkCount,
  expect,
  recoveryCard,
  startRecording,
  stopRecording,
  test,
  waitFor,
  waitForValue,
  watchRecordingProtocol,
} from "../fixtures.js";
import { devUsers } from "../support/env.js";
import { findTranscribeJob } from "../support/database.js";
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

/**
 * The other half of the same critical path: the tab itself dies, and the audio survives on the
 * device (CLAUDE.md — reconnect from `persistedSeq`, IndexedDB buffer).
 *
 * The spec above kills the server and keeps the page; this one keeps the server away *and* kills
 * the page, which is the case the local buffer exists for. Nothing in memory survives a reload —
 * not the protocol client, not the `MediaRecorder`, not the session state — so the only reason the
 * recording is not lost is that every chunk was written to IndexedDB before it was sent and was
 * never acknowledged. The count is read out of that database before the crash, so the assertion
 * afterwards is about audio that provably existed nowhere else.
 *
 * What is then asserted is the whole promise as the user meets it: the app offers to finish the
 * interrupted recording, one press delivers it, and object storage ends up with the same gap-free
 * sequence an uninterrupted recording would have produced.
 */
test("recovers audio a crashed tab left in the local buffer", async ({ page, signIn }) => {
  const alice = await fetchToken(devUsers.alice);
  const protocol = watchRecordingProtocol(page);

  await signIn(devUsers.alice);
  await page.goto("/record");
  await startRecording(page);

  const sessionId = await protocol.waitForSessionId();
  await protocol.waitForAck(2);
  const scope = { tenantId: alice.tenantId, userId: alice.userId, sessionId };
  const storedBeforeCrash = (await chunkSeqs(scope)).length;
  expect(storedBeforeCrash).toBeGreaterThan(0);

  // The server goes away, so from here everything the microphone produces piles up locally.
  await stopApi();

  const banner = page.getByRole("status").filter({ hasText: /buffered/ });
  await expect(banner).toBeVisible({ timeout: 30_000 });

  // Enough unacknowledged audio that losing the buffer would be a visible loss, confirmed where it
  // is actually held rather than inferred from the banner's wording.
  await waitFor(
    async () => (await bufferedChunkCount(page, sessionId)) >= 3,
    30_000,
    "chunks to pile up in the local buffer",
  );
  const bufferedAtCrash = await bufferedChunkCount(page, sessionId);

  // The crash: the page is gone mid-recording, with the server still unreachable. Nothing gets a
  // chance to finalize anything — the buffered session is simply orphaned.
  await page.reload();

  await startApi();

  // Back in the app, the device still knows about the recording nobody finished.
  await page.goto("/meetings");
  await expect(recoveryCard(page)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Upload and finish" })).toBeVisible();

  await page.getByRole("button", { name: "Upload and finish" }).click();
  await protocol.waitForFinalized(90_000);

  // The buffered audio reached object storage: more chunks than were there when the tab died, and
  // still one unbroken sequence — the recovery resumed the session rather than starting a new one.
  const seqs = await chunkSeqs(scope);
  expect(seqs).toEqual(seqs.map((_value, index) => index));
  expect(seqs.length).toBeGreaterThanOrEqual(storedBeforeCrash + bufferedAtCrash);

  const manifest = await readManifest(scope);
  expect(manifest?.tenantId).toBe(alice.tenantId);
  expect(manifest?.userId).toBe(alice.userId);
  expect(manifest?.persistedSeq).toBe(seqs.length - 1);
  expect(manifest?.chunkCount).toBe(seqs.length);

  // And it is a meeting like any other: one transcribe job, from the one session.
  const job = await waitForValue(
    () => findTranscribeJob(sessionId),
    30_000,
    "the transcribe job on the queue",
  );
  expect(job.sessionId).toBe(sessionId);
  expect(job.tenantId).toBe(alice.tenantId);

  // Nothing is left on the device asking to be finished a second time.
  await expect(recoveryCard(page)).toBeHidden({ timeout: 30_000 });
  expect(await bufferedChunkCount(page, sessionId)).toBe(0);
});
