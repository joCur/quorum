import {
  expect,
  startRecording,
  stopRecording,
  test,
  waitFor,
  waitForValue,
  watchRecordingProtocol,
} from "../fixtures.js";
import { devUsers, stackEnv } from "../support/env.js";
import { fetchToken } from "../support/keycloak.js";
import { findSummary, findTranscribeJob, findTranscript } from "../support/database.js";
import { chunkSeqs, readManifest } from "../support/storage.js";

/**
 * Critical path: recording → chunk streaming → persistence → transcript (CLAUDE.md).
 *
 * The browser records from Chromium's synthetic microphone, and every claim the UI makes is
 * checked against the two systems that actually hold the data: object storage and the database.
 */

test("records, persists every chunk and produces a transcript", async ({ page, signIn }) => {
  const alice = await fetchToken(devUsers.alice);
  const protocol = watchRecordingProtocol(page);

  await signIn(devUsers.alice);
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page).toHaveURL(/\/record$/);

  // Consent comes before the microphone, every single time.
  await startRecording(page);

  const sessionId = await protocol.waitForSessionId();

  // A few seconds of audio, confirmed as persisted by the server rather than by a timer.
  await protocol.waitForAck(3);

  await stopRecording(page);
  await protocol.waitForFinalized();
  // Finalizing returns the user to the meeting list.
  await expect(page).toHaveURL(/\/meetings$/);

  const scope = { tenantId: alice.tenantId, userId: alice.userId, sessionId };

  // The chunks are in object storage, under this tenant's and this user's prefix, with no gap.
  const seqs = await chunkSeqs(scope);
  expect(seqs.length).toBeGreaterThanOrEqual(4);
  expect(seqs).toEqual(seqs.map((_value, index) => index));

  // The session is finalized: the manifest agrees with what was acknowledged.
  const manifest = await readManifest(scope);
  expect(manifest).not.toBeNull();
  expect(manifest?.tenantId).toBe(alice.tenantId);
  expect(manifest?.userId).toBe(alice.userId);
  expect(manifest?.persistedSeq).toBe(seqs.length - 1);
  expect(manifest?.chunkCount).toBe(seqs.length);

  // A transcribe job reached the queue.
  const job = await waitForValue(
    () => findTranscribeJob(sessionId),
    30_000,
    "the transcribe job on the queue",
  );
  expect(job.tenantId).toBe(alice.tenantId);

  // And the worker turned it into a transcript row. The suite asserts that a transcript exists
  // and is scoped correctly, not what it says: the fake microphone produces a tone, not speech,
  // so the text is whatever the backend makes of it.
  const transcript = await waitForValue(
    () => findTranscript(sessionId),
    stackEnv.whisperMode === "real" ? 300_000 : 60_000,
    "the transcript row",
  );
  expect(transcript.tenantId).toBe(alice.tenantId);
  expect(transcript.userId).toBe(alice.userId);
  expect(transcript.meetingId).toBe(manifest?.meetingId);
  expect(transcript.isActive).toBe(true);

  // Exactly one active transcript for the meeting — no duplicate from a retried job.
  await waitFor(
    async () => (await findTranscript(sessionId))?.id === transcript.id,
    5_000,
    "a stable transcript id",
  );

  // And the transcript is summarized on its own, which is where the core path ends. The summary
  // backend is always the stub — the stack ships no LLM — so this asserts the chain and the
  // scoping, never the wording.
  const summary = await waitForValue(() => findSummary(sessionId), 60_000, "the summary row");
  expect(summary.transcriptId).toBe(transcript.id);
  expect(summary.meetingId).toBe(transcript.meetingId);
  expect(summary.tenantId).toBe(alice.tenantId);
  expect(summary.userId).toBe(alice.userId);
  expect(summary.isActive).toBe(true);
});
