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
import type { Page } from "@playwright/test";
import { devUsers, stackEnv } from "../support/env.js";
import { fetchToken } from "../support/keycloak.js";
import {
  findFailedJob,
  findSummary,
  findTranscribeJob,
  findTranscript,
} from "../support/database.js";
import { audioKey, expectRecordingIntact, objectSize, readManifest } from "../support/storage.js";

/**
 * The meeting name the stub summary backend suggests (`e2e/scripts/mock-whisper.mjs`). Repeated
 * here rather than imported: that module starts a server when it is loaded.
 */
const STUB_SUMMARY_TITLE = "Stub meeting about the release";

/** Critical path: recording → chunk streaming → persistence → transcript (CLAUDE.md). */

test("records, persists every chunk and produces a transcript", async ({ page, signIn }) => {
  const alice = await fetchToken(devUsers.alice);
  const protocol = watchRecordingProtocol(page);

  await signIn(devUsers.alice);

  // Terms Whisper has no reason to know, added the way a user adds them.
  await addVocabulary(page, ["MinIO", "Keycloak"]);

  await page.goto("/record");

  // This meeting is held in German, said on the stage before capture starts. Detection reads the
  // first half minute of audio and guesses wrong on a recording that opens without speech, which
  // is the failure the per-meeting choice exists to prevent.
  await page.getByLabel("Spoken language").selectOption("de");

  // Consent comes before the microphone, every single time.
  await startRecording(page);

  const sessionId = await protocol.waitForSessionId();

  // A few seconds of audio, confirmed as persisted by the server rather than by a timer.
  await protocol.waitForAck(3);

  await stopRecording(page);
  await protocol.waitForFinalized();
  await expect(page).toHaveURL(/\/meetings$/);

  const scope = { tenantId: alice.tenantId, userId: alice.userId, sessionId };

  const chunkCount = await expectRecordingIntact(scope, { atLeast: 4 });

  const manifest = await readManifest(scope);
  expect(manifest).not.toBeNull();
  expect(manifest?.tenantId).toBe(alice.tenantId);
  expect(manifest?.userId).toBe(alice.userId);
  expect(manifest?.persistedSeq).toBe(chunkCount - 1);

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

  // Recorded duration is derived from the audio, not taken on the client's word: the manifest
  // carries what the recorder asserted, and the transcript row carries the length the backend
  // decoded — the number the quota charges for.
  expect(typeof manifest?.recordedSeconds).toBe("number");
  expect(transcript.durationSeconds).toBeGreaterThan(0);

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

  // The request that produced it asked the backend to filter silence. This is the one place the
  // worker's transcription request can be seen from outside the worker, and getting it wrong is
  // invisible until a real meeting with a quiet opening comes back as a repetition loop.
  if (stackEnv.whisperMode === "mock") {
    const fields = await lastTranscriptionFields();
    expect(fields.vad_filter).toBe("true");
    // And it asked for the language the stage was showing. This is the whole chain seen from its
    // far end: a select on the recording screen, through the session record and the job payload,
    // into the request the worker makes.
    expect(fields.language).toBe("de");
    // And it carried the user's vocabulary as the prompt, sorted and joined the one way both sides
    // agree on. The backend silently drops the front of an over-long prompt, so this is the only
    // place the terms can be seen actually arriving rather than merely being stored.
    expect(fields.prompt).toBe("Keycloak, MinIO.");
    // What the meeting says it is in is what the transcription was made in, not a global default.
    expect(transcript.language).toBe("de");
  }

  // A cue index is the thing an incrementally written stream cannot have, and the reason a
  // scrub bar had nothing to draw (ADR-010). Checked on the bytes that leave the API rather than
  // on the object in the bucket, because the endpoint is what a player talks to.
  await waitForValue(() => objectSize(audioKey(scope)), 60_000, "the repackaged audio object");
  const audio = await page.request.get(
    `${stackEnv.apiUrl}/api/meetings/${transcript.meetingId}/audio`,
    { headers: { authorization: `Bearer ${alice.accessToken}` } },
  );
  expect(audio.status()).toBe(200);
  expect(audio.headers()["accept-ranges"]).toBe("bytes");
  const served = Buffer.from(await audio.body());
  expect([...served.subarray(0, 4)]).toEqual([0x1a, 0x45, 0xdf, 0xa3]);
  const cues = served.indexOf(Buffer.from([0x1c, 0x53, 0xbb, 0x6b]));
  expect(cues).toBeGreaterThan(-1);
  // And it is in front of the audio, so seeking costs a small ranged read of the head rather
  // than a walk to the end of a long recording.
  expect(cues).toBeLessThan(served.indexOf(Buffer.from([0x1f, 0x43, 0xb6, 0x75])));

  const seek = await page.request.get(
    `${stackEnv.apiUrl}/api/meetings/${transcript.meetingId}/audio`,
    {
      headers: { authorization: `Bearer ${alice.accessToken}`, range: "bytes=100-199" },
    },
  );
  expect(seek.status()).toBe(206);
  expect(seek.headers()["content-range"]).toBe(`bytes 100-199/${served.length}`);

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

    // Nobody named this recording, so the summary named it. The stub suggests a fixed title, and
    // the meeting carries it instead of the "Untitled" placeholder. Asserted against the stub
    // only: a real backend picks its own words.
    //
    // No reload: the name is written in the same transaction as the summary, so the very read
    // that showed the summary above carries it. A screen that had to be refreshed by hand to
    // learn its own title is the bug this asserts is absent.
    await expect(page.getByRole("heading", { name: STUB_SUMMARY_TITLE })).toBeVisible();

    // And in the list, on this meeting's own row — every recording the suite makes gets the same
    // stub name, so the row is addressed by the meeting it links to.
    await page.goto("/meetings");
    await expect(page.locator(`a[href="/meetings/${transcript.meetingId}"]`)).toContainText(
      STUB_SUMMARY_TITLE,
      { timeout: 30_000 },
    );

    // A generated name is a suggestion, so it can be corrected. The rename is what makes that
    // true, and it is the reason the machine is allowed to write the field at all.
    await page.goto(`/meetings/${transcript.meetingId}`);
    await page.getByRole("button", { name: "Rename meeting" }).click();
    const field = page.getByRole("textbox", { name: "Meeting title" });
    await field.fill("Named by hand");
    await page.getByRole("button", { name: "Save name" }).click();
    await expect(page.getByRole("heading", { name: "Named by hand" })).toBeVisible();

    await page.goto("/meetings");
    await expect(page.locator(`a[href="/meetings/${transcript.meetingId}"]`)).toContainText(
      "Named by hand",
    );
  }
});

/**
 * Critical path, unhappy end: the pipeline fails, the screen says so in the user's own terms, and
 * the user gets out of it without an operator.
 *
 * The stub backend is told to refuse the next transcription, so a real job fails for a real
 * reason. What is asserted first is what the user is left with: a translated sentence about their
 * recording, the developer-facing string the pipeline logged nowhere on the page, and the code
 * available a click down for support. Then the second half of the same story — the retry that
 * turns that dead end back into a transcript, which until it existed only an operator redrive
 * could do.
 */
test("says a recording could not be transcribed, and transcribes it on a retry", async ({
  page,
  signIn,
}) => {
  test.skip(
    stackEnv.whisperMode !== "mock",
    "only the stub backend can be told to refuse a transcription",
  );

  const alice = await fetchToken(devUsers.alice);
  const protocol = watchRecordingProtocol(page);

  await rejectNextTranscription();

  await signIn(devUsers.alice);
  await page.goto("/record");
  await startRecording(page);

  const sessionId = await protocol.waitForSessionId();
  await protocol.waitForAck(2);
  await stopRecording(page);
  await protocol.waitForFinalized();

  const manifest = await readManifest({
    tenantId: alice.tenantId,
    userId: alice.userId,
    sessionId,
  });
  expect(manifest?.meetingId).toBeTruthy();

  // The failure is a fact about the pipeline first: the job row carries the code, and the message
  // the old panel used to print verbatim.
  const failed = await waitForValue(
    () => findFailedJob(sessionId, "transcribe"),
    60_000,
    "the failed transcribe job",
  );
  expect(failed.code).toBe("TRANSCRIPTION_REJECTED");
  expect(failed.message).toContain("404");

  await page.goto(`/meetings/${manifest?.meetingId}`);

  // What the user reads is about their recording — and it is the only message on the panel.
  //
  // A negative assertion here searches the whole document, hidden nodes included, and matches
  // substrings — so the needle has to be one that only a real leak can produce. A short digit
  // sequence is not: the support reference on the panel is a random UUID, and about one in a
  // hundred contains "404" somewhere in its hex. The word-boundary pattern is immune to that,
  // because hex delimits digits with word characters ("dc51c4049f1c") while a leaked status is
  // delimited by punctuation and spaces ("answered 404:"). The two prose needles need no such
  // care, and are kept long enough that nothing else can produce them.
  await expect(page.getByText("Transcription failed")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("This recording could not be transcribed.")).toBeVisible();
  await expect(page.getByText(failed.message)).toHaveCount(0);
  await expect(page.getByText("is not installed locally")).toHaveCount(0);
  await expect(page.getByText(/\b404\b/)).toHaveCount(0);

  // The code stays reachable for support, one click down rather than in the sentence.
  await page.getByText("Technical details").click();
  await expect(page.getByText("Error code: TRANSCRIPTION_REJECTED")).toBeVisible();
  await expect(page.getByText(`Reference: ${failed.id}`)).toBeVisible();

  // And the failure costs nothing that succeeded: the audio is still there to play.
  await expect(page.getByRole("group", { name: "Playback" })).toBeVisible();

  // The way out is on the panel, because this failure is about the backend rather than about the
  // recording: the stub refused once and answers normally from here, which is the shape of the
  // real case this exists for — an operator installs the model the backend was missing and the
  // user asks again.
  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible();
  await retry.click();

  // The meeting stops reporting a failure the moment the retry is accepted — the job row is back
  // on the queue, and the screen has to stop offering an action the user has already taken.
  await expect(page.getByText("Transcription failed")).toHaveCount(0, { timeout: 30_000 });

  // And the retry is a real run of the real pipeline: the transcript row appears, scoped to this
  // user, and the words reach the screen the user is already looking at. The stub backend is the
  // only one this case runs against, so its one known sentence is what the screen has to show.
  const transcript = await waitForValue(
    () => findTranscript(sessionId),
    60_000,
    "the transcript row the retry produced",
  );
  expect(transcript.tenantId).toBe(alice.tenantId);
  expect(transcript.userId).toBe(alice.userId);
  expect(transcript.meetingId).toBe(manifest?.meetingId);
  expect(transcript.isActive).toBe(true);

  await expect(page.getByText("This is a mock transcription")).toBeVisible({ timeout: 60_000 });
});

/**
 * Adds terms through the screens rather than the API, so the settings-to-subpage route is covered
 * too. Each term is confirmed before the next is typed, so a failed save surfaces here instead of
 * further down the test.
 */
async function addVocabulary(page: Page, terms: string[]): Promise<void> {
  await page.goto("/settings");
  await page.getByRole("link", { name: /Manage/ }).click();
  await expect(page).toHaveURL(/\/settings\/vocabulary$/);

  for (const term of terms) {
    await page.getByLabel("Add a term").fill(term);
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByRole("button", { name: `Remove ${term}` })).toBeVisible();
  }

  await expect(page.getByText(`${terms.length} of 40 terms`)).toBeVisible();
}

/**
 * The form fields of the last transcription request the stub backend received.
 *
 * The stub records them by name rather than parsing multipart properly, so a missing field and a
 * field the stub could not find look the same — which is exactly why the assertion is on the value
 * the worker is configured to send, not on absence.
 */
async function lastTranscriptionFields(): Promise<Record<string, string | null>> {
  const response = await fetch(`${stackEnv.mockBackendUrl}/control/last-transcription`);
  if (!response.ok) {
    throw new Error(
      `could not read the stub backend's last request at ${stackEnv.mockBackendUrl}: ${response.status}`,
    );
  }
  const body = (await response.json()) as { fields: Record<string, string | null> | null };
  if (!body.fields) throw new Error("the stub backend saw no transcription request");
  return body.fields;
}

async function rejectNextTranscription(): Promise<void> {
  const response = await fetch(`${stackEnv.mockBackendUrl}/control/reject-transcription`, {
    method: "POST",
  });
  if (!response.ok) {
    throw new Error(
      `could not arm the stub backend at ${stackEnv.mockBackendUrl}: ${response.status}`,
    );
  }
}

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
  const chunkCount = await expectRecordingIntact(scope, { atLeast: seqsBeforePause + 2 });

  // One manifest, one meeting — and the marks record where the pause was, which is what lets the
  // pipeline map audio time back to wall clock.
  const manifest = await readManifest(scope);
  expect(manifest?.persistedSeq).toBe(chunkCount - 1);
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

  await expectRecordingIntact({ tenantId: alice.tenantId, userId: alice.userId, sessionId });

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

  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(page).toHaveURL(/\/meetings$/);

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
  const chunkCount = await expectRecordingIntact(scope, { atLeast: ackedAway + 2 });

  const manifest = await readManifest(scope);
  expect(manifest?.chunkCount).toBe(chunkCount);
  expect(manifest?.persistedSeq).toBe(chunkCount - 1);

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
  const chunkCount = await expectRecordingIntact(scope, { atLeast: 4 });

  const manifest = await readManifest(scope);
  expect(manifest?.tenantId).toBe(alice.tenantId);
  expect(manifest?.userId).toBe(alice.userId);
  expect(manifest?.persistedSeq).toBe(chunkCount - 1);

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
