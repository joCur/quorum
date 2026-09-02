import type { Page } from "@playwright/test";
import {
  expect,
  startRecording,
  stopRecording,
  test,
  waitForValue,
  watchRecordingProtocol,
} from "../fixtures.js";
import { devUsers, stackEnv } from "../support/env.js";
import { fetchToken } from "../support/keycloak.js";
import {
  countCorrections,
  findSummary,
  findTranscript,
  storedSegmentText,
} from "../support/database.js";

/**
 * Critical path: the core loop, continued past the transcript — a user correcting what the
 * machine heard (CLAUDE.md path 1, ADR-003 §2, ADR-010).
 *
 * The correction is made in the browser and then checked in the two places that decide whether it
 * is real: the row in the overlay table, and the transcript document, which has to come out of the
 * whole exercise byte for byte as the worker wrote it. A correction the screen shows over machine
 * output it quietly rewrote would satisfy every UI assertion and break the promise the feature
 * rests on.
 *
 * SPEAKER REASSIGNMENT is exercised here only through the refusal. Diarization is not in the
 * pipeline yet — `worker/src/transcript/map.ts` writes an empty `speakers[]` — so a real recording
 * has no speaker to reassign to, and the picker correctly does not appear. What the suite can hold
 * is the server's answer to a speaker the transcript does not know, which is the assertion that
 * keeps a dangling reference out of the data. The editor itself is covered against a diarized
 * transcript in `client/test/components/transcript-corrections.test.tsx`.
 */

/** The sentence the stub transcription backend produces (`e2e/scripts/mock-whisper.mjs`). */
const SPOKEN = "This is a mock transcription produced by the end-to-end suite.";
const CORRECTED = "This is a transcription the user corrected by hand.";

test("corrects a transcript segment, keeps the original, and dates the summary", async ({
  page,
  signIn,
}) => {
  test.skip(
    stackEnv.whisperMode !== "mock",
    "the correction is made against the sentence only the stub backend is known to produce",
  );

  const alice = await fetchToken(devUsers.alice);
  const carol = await fetchToken(devUsers.carol);
  const protocol = watchRecordingProtocol(page);
  const title = `Transcript corrections ${Date.now()}`;

  await signIn(devUsers.alice);
  await page.goto("/record");
  await page.getByLabel("Meeting title").fill(title);
  await startRecording(page);
  const sessionId = await protocol.waitForSessionId();
  await protocol.waitForAck(2);
  await stopRecording(page);
  await protocol.waitForFinalized();

  const meetingId = protocol.meetingId as string;
  expect(meetingId).toBeTruthy();

  // A summary as well as a transcript: the staleness note is a comparison against the summary's
  // own creation time, so there has to be one before the correction is made.
  const transcript = await waitForValue(() => findTranscript(sessionId), 60_000, "the transcript");
  await waitForValue(() => findSummary(sessionId), 60_000, "the summary row");

  await page.goto(`/meetings/${meetingId}`);
  await expect(page.getByText(SPOKEN)).toBeVisible({ timeout: 30_000 });
  // Matched exactly: `getByText` is a case-insensitive substring match, and both the corrected
  // passage and the staleness note contain the word. Only the marker is spelled exactly this way.
  await expect(page.getByText("Corrected", { exact: true })).toHaveCount(0);

  // Diarization does not exist yet, so this transcript knows no speakers and the editor offers no
  // picker. The server is what keeps that from being worked around.
  const segmentId = await firstSegmentId(page, meetingId, alice.accessToken);
  const correctionUrl = `${stackEnv.apiUrl}/api/meetings/${meetingId}/transcript/segments/${segmentId}/correction`;
  const unknownSpeaker = await page.request.put(correctionUrl, {
    headers: { authorization: `Bearer ${alice.accessToken}` },
    data: { editedText: null, editedSpeakerId: "55555555-0000-4000-8000-000000000001" },
    failOnStatusCode: false,
  });
  expect(unknownSpeaker.status()).toBe(400);
  expect((await unknownSpeaker.json()).error).toBe("unknown_speaker");

  // Another tenant cannot correct this meeting, and is told nothing about whether it exists.
  const intruder = await page.request.put(correctionUrl, {
    headers: { authorization: `Bearer ${carol.accessToken}` },
    data: { editedText: "not theirs to write", editedSpeakerId: null },
    failOnStatusCode: false,
  });
  expect(intruder.status()).toBe(404);

  // The correction itself, made the way a user makes it.
  await page
    .getByRole("button", { name: /^Correct the passage at/ })
    .first()
    .click();
  const field = page.getByRole("textbox", { name: "Corrected text" });
  await expect(field).toHaveValue(SPOKEN);
  // The original stays readable while it is being replaced — the promise, in the interface.
  await expect(page.getByText("Recorded as:")).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Speaker" })).toHaveCount(0);

  await field.fill(CORRECTED);
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page.getByText(CORRECTED)).toBeVisible();
  await expect(page.getByText("Corrected", { exact: true })).toBeVisible();
  await expect(page.getByText(SPOKEN)).toHaveCount(0);

  // It survives a reload, which is the difference between an edited screen and stored data.
  await page.reload();
  await expect(page.getByText(CORRECTED)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Corrected", { exact: true })).toBeVisible();

  // One overlay row, and the machine's own words untouched underneath it (ADR-010 §1).
  expect(await countCorrections(meetingId)).toBe(1);
  expect(await storedSegmentText(sessionId)).toBe(SPOKEN);

  // The summary was written before the correction, and now says so.
  await expect(
    page.getByText("The transcript was corrected after this summary was written."),
  ).toBeVisible();

  // The way back. The original is not restored from a copy — there is nothing to restore, because
  // it was never overwritten; the row simply goes.
  await page.getByRole("button", { name: "Restore the original wording" }).click();
  await expect(page.getByText(SPOKEN)).toBeVisible();
  await expect(page.getByText("Corrected", { exact: true })).toHaveCount(0);

  await page.reload();
  await expect(page.getByText(SPOKEN)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("Corrected", { exact: true })).toHaveCount(0);
  expect(await countCorrections(meetingId)).toBe(0);

  // And with the last correction gone the summary is no longer behind anything.
  await expect(
    page.getByText("The transcript was corrected after this summary was written."),
  ).toHaveCount(0);

  expect(transcript.meetingId).toBe(meetingId);
});

/** The segment the correction endpoints are addressed with, read from the API's own answer. */
async function firstSegmentId(page: Page, meetingId: string, accessToken: string): Promise<string> {
  const response = await page.request.get(`${stackEnv.apiUrl}/api/meetings/${meetingId}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const body = (await response.json()) as { transcript: { segments: { id: string }[] } | null };
  const id = body.transcript?.segments[0]?.id;
  if (!id) throw new Error("the meeting has no transcript segment to correct");
  return id;
}
