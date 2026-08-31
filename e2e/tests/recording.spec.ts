import {
  captureModeButton,
  capturedAudioConstraints,
  displayCaptureReport,
  expect,
  fakeAudioInputs,
  pauseRecording,
  recordingBar,
  recordingTimer,
  resumeRecording,
  startOnlineRecording,
  startRecording,
  stopButton,
  stopRecording,
  stopSharing,
  test,
  useFakeInputDevices,
  waitFor,
  waitForValue,
  watchDisplayCapture,
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

  // And the user can read both. Everything above is the pipeline seen from behind it; the core
  // path only ends where the meeting screen shows what came out — a summary and a transcript, not
  // the "still working" placeholders that stand in until they exist.
  await page.goto(`/meetings/${transcript.meetingId}`);
  await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Transcript" })).toBeVisible();
  if (stackEnv.whisperMode === "mock") {
    // The stub transcription backend says one known sentence, so with it the screen can be held to
    // showing the words that were transcribed rather than merely to showing something.
    await expect(page.getByText("This is a mock transcription")).toBeVisible({ timeout: 30_000 });
  }
});

/**
 * Critical path: the two gestures that guard capture — consent before it, and the hold that ends
 * it — now live on the stage instead of in dialogs. Both are asserted in a real browser, because
 * both are things no unit test can hold: the notice being on screen before the microphone is ever
 * asked for, and a real mouse press that is too short to stop the recording.
 */
test("takes consent on the stage and refuses to stop on a short press", async ({
  page,
  signIn,
}) => {
  const protocol = watchRecordingProtocol(page);

  await signIn(devUsers.alice);
  await page.goto("/record");

  // The notice is on the stage, not in front of it: nothing is modal, and the field beside it is
  // usable without answering anything first.
  await expect(page.getByTestId("consent-card")).toBeVisible();
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.getByLabel("Meeting title").fill("Consent on the stage");

  // Nothing has been captured yet — the button below the notice is what asks for the microphone.
  expect(protocol.persistedSeq).toBe(-1);
  await startRecording(page);
  const sessionId = await protocol.waitForSessionId();
  await protocol.waitForAck(2);

  // A short press is the pocket-stop the hold exists to prevent. The ring starts filling and then
  // empties, and the recording is still running afterwards.
  const stop = stopButton(page);
  await stop.hover();
  await page.mouse.down();
  await expect(page.getByTestId("hold-to-stop-hint")).toHaveText("Keep holding…");
  await page.mouse.up();
  await expect(page.getByTestId("hold-to-stop-hint")).toHaveText("Hold to stop");

  const seqsAfterShortPress = protocol.persistedSeq;
  await protocol.waitForAck(seqsAfterShortPress + 2);
  await expect(stop).toBeVisible();

  // The full hold does end it, and the session finalizes like any other.
  await stopRecording(page);
  await protocol.waitForFinalized();
  await expect(page).toHaveURL(/\/meetings$/);
  expect(sessionId).not.toBe("");
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

/**
 * Critical path: leaving the recording screen must not leave half a meeting behind.
 *
 * This is the failure the whole app-level session ownership exists to prevent — a back gesture,
 * a tab, a link, and the meeting was cut in two. The assertions are the same continuity ones the
 * pause test makes, because the property is the same: one session, one meeting, no gap. What is
 * added is that the user can still see the recording from wherever they went, and get back to it.
 */
test("keeps recording while the user browses the rest of the app", async ({ page, signIn }) => {
  const alice = await fetchToken(devUsers.alice);
  const protocol = watchRecordingProtocol(page);

  await signIn(devUsers.alice);
  await page.goto("/record");
  await startRecording(page);

  const sessionId = await protocol.waitForSessionId();
  await protocol.waitForAck(2);
  const ackedOnScreen = protocol.persistedSeq;

  // Away from the recording screen, the ordinary way: the screen's own way out.
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(/\/meetings$/);

  // The recording is still there, and says so.
  await expect(recordingBar(page)).toBeVisible();
  await expect(recordingBar(page)).toContainText("REC");

  // And keeps going while the user browses. The chunk sequence is what proves capture never
  // stopped — the strip could be lying, object storage cannot.
  await page.getByRole("link", { name: "Templates" }).click();
  await expect(page).toHaveURL(/\/templates$/);
  await expect(recordingBar(page)).toBeVisible();
  await protocol.waitForAck(ackedOnScreen + 3);

  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(recordingBar(page)).toBeVisible();
  const ackedAway = protocol.persistedSeq;

  // Back to the recording, through the strip. The screen re-attaches to the session that has been
  // running all along rather than offering to start a new one: the timer is well past zero, the
  // record control is in its stop form, and no second `session.ready` was ever issued.
  await recordingBar(page).click();
  await expect(page).toHaveURL(/\/record$/);
  await expect(stopButton(page)).toBeVisible();
  await expect(recordingTimer(page)).not.toHaveText("00:00");
  expect(protocol.sessionId).toBe(sessionId);

  await protocol.waitForAck(ackedAway + 2);
  await stopRecording(page);
  await protocol.waitForFinalized();
  await expect(page).toHaveURL(/\/meetings$/);

  const scope = { tenantId: alice.tenantId, userId: alice.userId, sessionId };

  // One gap-free sequence across the whole excursion — one meeting, not two halves.
  const seqs = await chunkSeqs(scope);
  expect(seqs).toEqual(seqs.map((_value, index) => index));
  expect(seqs.length).toBeGreaterThan(ackedAway + 1);

  const manifest = await readManifest(scope);
  expect(manifest?.chunkCount).toBe(seqs.length);
  expect(manifest?.persistedSeq).toBe(seqs.length - 1);

  // Exactly one transcribe job: the excursion produced no second session to transcribe.
  const job = await waitForValue(
    () => findTranscribeJob(sessionId),
    30_000,
    "the transcribe job on the queue",
  );
  expect(job.sessionId).toBe(sessionId);

  // And nothing is left over on the device asking to be finished — the recovery card is the
  // symptom of the bug this test exists for.
  await expect(page.getByText("A recording was interrupted")).toBeHidden();
});

/**
 * Critical path: an online meeting reaches the same pipeline as one in the room.
 *
 * What a browser can be made to prove here is the plumbing, and the plumbing is the risky part:
 * the mode reaches capture, the share is asked for with the constraints that make sound available
 * at all, the video track that the API forces on us is dead before a frame of it is read, and the
 * mixed result streams and finalizes through the unchanged protocol — one session, one gap-free
 * chunk sequence, one meeting.
 *
 * What it cannot prove is the sound itself. Chromium's synthetic display source hands back a
 * generated tone rather than the audio of a real meeting app, so "the remote voices are audible in
 * the recording" stays a manual check on a real machine with a real call.
 */
test("records an online meeting as sound only, through the unchanged pipeline", async ({
  page,
  signIn,
}) => {
  const alice = await fetchToken(devUsers.alice);
  const protocol = watchRecordingProtocol(page);
  await watchDisplayCapture(page);

  await signIn(devUsers.alice);
  await page.goto("/record");

  // The mode is a choice on the stage, next to the consent notice rather than instead of it.
  await expect(captureModeButton(page, "in-person")).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("capture-mode-note")).toContainText(
    "Records the microphone — everyone in the room",
  );
  await captureModeButton(page, "online").click();

  // The promise the mode is asking to be believed, on screen before anything is shared.
  await expect(page.getByTestId("capture-mode-note")).toContainText("Quorum takes only the sound");
  await expect(page.getByTestId("consent-card")).toContainText("everyone in the call");

  await startOnlineRecording(page);
  const sessionId = await protocol.waitForSessionId();

  // The share was asked for once, and asked for the sound of a window or a screen — the hints
  // without which a native meeting app is inaudible on Chromium.
  const share = await displayCaptureReport(page);
  expect(share.calls).toBe(1);
  expect(share.constraints[0]).toMatchObject({
    systemAudio: "include",
    windowAudio: "system",
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
  });

  // And the video the API insisted on is already stopped, while the recording runs.
  expect(share.videoTracks).toHaveLength(1);
  expect(share.videoTracks[0]?.readyState).toBe("ended");

  // From here the protocol has no idea this recording had two sources.
  await protocol.waitForAck(3);
  await stopRecording(page);
  await protocol.waitForFinalized();
  await expect(page).toHaveURL(/\/meetings$/);

  const scope = { tenantId: alice.tenantId, userId: alice.userId, sessionId };
  const seqs = await chunkSeqs(scope);
  expect(seqs.length).toBeGreaterThanOrEqual(4);
  expect(seqs).toEqual(seqs.map((_value, index) => index));

  const manifest = await readManifest(scope);
  expect(manifest?.tenantId).toBe(alice.tenantId);
  expect(manifest?.userId).toBe(alice.userId);
  expect(manifest?.chunkCount).toBe(seqs.length);
  expect(manifest?.persistedSeq).toBe(seqs.length - 1);

  // One audio-only meeting, indistinguishable downstream from one recorded in a room.
  const job = await waitForValue(
    () => findTranscribeJob(sessionId),
    30_000,
    "the transcribe job on the queue",
  );
  expect(job.tenantId).toBe(alice.tenantId);
});

/**
 * The one thing the mode must never do quietly: carry on without the call.
 *
 * Stopping the share is a control the browser owns and the app cannot see coming. Ending the track
 * from inside the page is the closest a test can get to the user pressing it, and the assertion is
 * the honest half of the behavior — capture stops, red leaves the screen, the audio so far is
 * still there, and the screen says what happened instead of recording a call it can no longer
 * hear. Re-sharing from the resume button needs a real user gesture on a real picker and stays a
 * manual check.
 */
test("pauses honestly when the shared sound is stopped from the browser", async ({
  page,
  signIn,
}) => {
  const protocol = watchRecordingProtocol(page);
  await watchDisplayCapture(page);

  await signIn(devUsers.alice);
  await page.goto("/record");
  await startOnlineRecording(page);

  await protocol.waitForSessionId();
  await protocol.waitForAck(2);
  const capturedBeforeStop = protocol.persistedSeq;

  // The browser's own "Stop sharing", as the page experiences it: the track simply ends.
  await stopSharing(page);

  // The recording is paused, not failed and not silently continued on the microphone alone.
  await expect(page.getByTestId("display-ended-notice")).toBeVisible();
  await expect(page.getByText("PAUSE", { exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);

  // Nothing captured while paused, and everything captured before it is still on its way.
  await page.waitForTimeout(2_000);
  expect(protocol.persistedSeq).toBeLessThanOrEqual(capturedBeforeStop + 1);

  // Stopping from here keeps what was recorded — the meeting is finalized, not discarded.
  await stopRecording(page);
  await protocol.waitForFinalized();
  await expect(page).toHaveURL(/\/meetings$/);
});
