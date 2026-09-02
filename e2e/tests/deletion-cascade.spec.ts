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
import {
  countCorrections,
  countQueueRows,
  countRowsForSession,
  findSummary,
  findTranscript,
} from "../support/database.js";
import { audioKey, listKeys, objectSize, sessionPrefix } from "../support/storage.js";

/**
 * Critical path: deleting a meeting completely — audio, transcripts, summaries and jobs
 * (CLAUDE.md, ADR-001).
 *
 * The meeting is recorded and deleted through the UI, and what the deletion promise actually
 * means is then checked where the data lives: no objects left under the session prefix, and no
 * derived rows in the database. A meeting that disappears from a list while its audio survives
 * would satisfy the screen and break the promise.
 */

test("deletes a meeting and everything derived from it", async ({ page, signIn }) => {
  const alice = await fetchToken(devUsers.alice);
  const carol = await fetchToken(devUsers.carol);
  const protocol = watchRecordingProtocol(page);
  const title = `Deletion cascade ${Date.now()}`;

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

  // Deleting a meeting mid-pipeline would prove less: wait until there is something derived.
  await waitForValue(() => findTranscript(sessionId), 60_000, "the transcript row");
  await waitForValue(() => findSummary(sessionId), 60_000, "the summary row");

  const scope = { tenantId: alice.tenantId, userId: alice.userId, sessionId };
  const prefix = sessionPrefix(scope);
  expect((await listKeys(prefix)).length).toBeGreaterThan(0);

  // The audio ends up as one repackaged, seekable object rather than the chunks it arrived as
  // (ADR-010), and that object is what the cascade then has to remove. Waiting for it here is
  // what makes the assertion below about the shape a meeting is actually deleted in, instead of
  // whichever shape the pipeline happened to be mid-way through.
  const artifactBytes = await waitForValue(
    () => objectSize(audioKey(scope)),
    60_000,
    "the repackaged audio object",
  );
  expect(artifactBytes).toBeGreaterThan(0);
  expect(await listKeys(`${prefix}/chunks/`)).toEqual([]);

  const meetingUrl = `${stackEnv.apiUrl}/api/meetings/${meetingId}`;
  const asAlice = { authorization: `Bearer ${alice.accessToken}` };

  // A correction, so the cascade has one to take with it. Corrections are the user's own words
  // about the meeting — the last thing a deletion may leave lying around (ADR-011 §7).
  const detail = await page.request.get(meetingUrl, { headers: asAlice });
  const segments = ((await detail.json()) as { transcript: { segments: { id: string }[] } })
    .transcript.segments;
  const corrected = await page.request.put(
    `${meetingUrl}/transcript/segments/${segments[0]?.id ?? ""}/correction`,
    { headers: asAlice, data: { editedText: "Corrected before deletion.", editedSpeakerId: null } },
  );
  expect(corrected.status()).toBe(200);
  // Guards the assertion after the delete against passing because there was never a row.
  expect(await countCorrections(meetingId)).toBe(1);

  // Another tenant cannot delete it, and is told nothing about whether it exists.
  const intruder = await page.request.delete(meetingUrl, {
    headers: { authorization: `Bearer ${carol.accessToken}` },
    failOnStatusCode: false,
  });
  expect(intruder.status()).toBe(404);
  expect((await listKeys(prefix)).length).toBeGreaterThan(0);

  await expect(page).toHaveURL(/\/meetings$/);
  const deleteButton = page.getByRole("button", { name: `Delete ${title}` });
  await expect(deleteButton).toBeVisible({ timeout: 30_000 });

  // A meeting recorded a moment ago is filed under today, and the row it is deleted from is the
  // one inside that day's panel — the grouping is not decoration around the delete flow, it is
  // where the row now lives.
  const today = page.getByRole("region", { name: "Today" });
  await expect(today.getByText(title)).toBeVisible();
  await expect(today.getByRole("button", { name: `Delete ${title}` })).toBeVisible();

  await deleteButton.click();

  await expect(page.getByText("Delete this meeting?")).toBeVisible();
  await page.getByRole("button", { name: "Delete permanently" }).click();

  await expect(deleteButton).toBeHidden({ timeout: 30_000 });

  // The list hides the row as soon as the request is accepted, so the row disappearing is not yet
  // proof that anything was deleted. The endpoint deletes storage first and the database second —
  // deliberately, so a crash in between leaves a meeting the user can simply delete again — which
  // means a 404 from the read API is the one signal that says *both* steps are done. Waiting for
  // that, rather than for the audio to vanish, is what makes the assertions below unambiguous.
  await waitFor(
    async () => {
      const probe = await page.request.get(meetingUrl, {
        headers: asAlice,
        failOnStatusCode: false,
      });
      return probe.status() === 404;
    },
    30_000,
    "the meeting to be gone from the read API",
  );

  // The cascade, checked where the data lives. The prefix assertion covers the repackaged audio
  // by construction, and the key is named again so a change that stopped removing it fails here
  // with the reason rather than as a puzzling non-empty listing.
  expect(await objectSize(audioKey(scope))).toBeNull();
  expect(await listKeys(prefix)).toEqual([]);
  expect(await countRowsForSession("transcripts", sessionId)).toBe(0);
  expect(await countRowsForSession("summaries", sessionId)).toBe(0);
  expect(await countRowsForSession("jobs", sessionId)).toBe(0);
  expect(await countCorrections(meetingId)).toBe(0);
  // Including pg-boss's own rows: a job left in the queue would write a transcript for a meeting
  // that no longer exists.
  expect(await countQueueRows(meetingId)).toBe(0);

  // Deleting again is a 404, not an error — which is what makes a retry after a crash safe.
  const again = await page.request.delete(meetingUrl, {
    headers: asAlice,
    failOnStatusCode: false,
  });
  expect(again.status()).toBe(404);
});
