import {
  capturedAudioConstraints,
  expect,
  fakeAudioInputs,
  pauseRecording,
  recordingTimer,
  resumeRecording,
  startRecording,
  stopRecording,
  test,
  useFakeInputDevices,
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
  await page.goto("/record");

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

/**
 * Critical path: a break in the middle of a meeting must not split it in two.
 *
 * Pausing is the one control that touches capture without ending the session, so the assertions
 * are about continuity: one meeting, one gap-free chunk sequence, and a recorded time that counts
 * audio rather than wall clock.
 */
test("pauses and resumes without splitting the meeting", async ({ page, signIn }) => {
  const alice = await fetchToken(devUsers.alice);
  const protocol = watchRecordingProtocol(page);

  await signIn(devUsers.alice);
  await page.goto("/record");
  await startRecording(page);

  const sessionId = await protocol.waitForSessionId();
  await protocol.waitForAck(2);
  const seqsBeforePause = protocol.persistedSeq;

  await pauseRecording(page);
  const pausedTime = await recordingTimer(page).textContent();

  // Long enough that a wall-clock timer would visibly move on. Nothing may be captured here: the
  // recorded time is audio time, and the pause spends none of it.
  await page.waitForTimeout(3_000);
  await expect(recordingTimer(page)).toHaveText(pausedTime ?? "");

  await resumeRecording(page);
  // The sequence picks up where it stopped rather than starting a second recording.
  await protocol.waitForAck(seqsBeforePause + 3);

  await stopRecording(page);
  await protocol.waitForFinalized();
  await expect(page).toHaveURL(/\/meetings$/);

  const scope = { tenantId: alice.tenantId, userId: alice.userId, sessionId };

  // One session prefix in object storage, and no gap where the break was.
  const seqs = await chunkSeqs(scope);
  expect(seqs).toEqual(seqs.map((_value, index) => index));
  expect(seqs.length).toBeGreaterThan(seqsBeforePause + 1);

  // One manifest, one meeting — and the marks record where the pause was, which is what lets the
  // pipeline map audio time back to wall clock.
  const manifest = await readManifest(scope);
  expect(manifest?.chunkCount).toBe(seqs.length);
  expect(manifest?.persistedSeq).toBe(seqs.length - 1);
  expect(manifest?.marks.map((mark) => mark.type)).toEqual(["pause", "resume"]);

  // Exactly one transcribe job for the whole meeting, break included.
  const job = await waitForValue(
    () => findTranscribeJob(sessionId),
    30_000,
    "the transcribe job on the queue",
  );
  expect(job.sessionId).toBe(sessionId);
  expect(job.tenantId).toBe(alice.tenantId);
});

/**
 * The chosen microphone reaches capture, and is still chosen next time.
 *
 * Two named inputs are injected because Chromium offers one unnamed fake device, which is the
 * case where the product deliberately shows nothing. What is asserted is the contract the picker
 * exists for: the device id travels into the `getUserMedia` constraint, and the choice survives a
 * reload — with the recording itself still producing a gap-free chunk sequence.
 */
test("records with the microphone the user picked", async ({ page, signIn }) => {
  const alice = await fetchToken(devUsers.alice);
  const protocol = watchRecordingProtocol(page);

  await useFakeInputDevices(page);
  await signIn(devUsers.alice);
  await page.goto("/record");

  const picker = page.getByLabel("Microphone", { exact: true });
  await expect(picker).toBeVisible();
  await picker.selectOption(fakeAudioInputs[0]!.deviceId);

  await startRecording(page);
  const sessionId = await protocol.waitForSessionId();

  const constraints = await capturedAudioConstraints(page);
  expect(constraints.at(-1)?.deviceId).toEqual({ exact: fakeAudioInputs[0]!.deviceId });

  await protocol.waitForAck(2);
  await stopRecording(page);
  await protocol.waitForFinalized();

  const seqs = await chunkSeqs({ tenantId: alice.tenantId, userId: alice.userId, sessionId });
  expect(seqs).toEqual(seqs.map((_value, index) => index));

  // The choice is a property of this machine, so it is still there on the next visit.
  await page.goto("/record");
  await expect(page.getByLabel("Microphone", { exact: true })).toHaveValue(
    fakeAudioInputs[0]!.deviceId,
  );
});
