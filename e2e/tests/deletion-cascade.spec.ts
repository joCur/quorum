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
import { countRowsForSession, findSummary, findTranscript } from "../support/database.js";
import { listKeys, sessionPrefix } from "../support/storage.js";

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

  const prefix = sessionPrefix({ tenantId: alice.tenantId, userId: alice.userId, sessionId });
  expect((await listKeys(prefix)).length).toBeGreaterThan(0);

  const meetingUrl = `${stackEnv.apiUrl}/api/meetings/${meetingId}`;
  const asAlice = { authorization: `Bearer ${alice.accessToken}` };

  // Another tenant cannot delete it, and is told nothing about whether it exists.
  const intruder = await page.request.delete(meetingUrl, {
    headers: { authorization: `Bearer ${carol.accessToken}` },
    failOnStatusCode: false,
  });
  expect(intruder.status()).toBe(404);
  expect((await listKeys(prefix)).length).toBeGreaterThan(0);

  // The meeting is on the list, and the delete flow is two steps: the row's control, then an
  // explicit confirmation that names what goes with it.
  await expect(page).toHaveURL(/\/meetings$/);
  const deleteButton = page.getByRole("button", { name: `Delete ${title}` });
  await expect(deleteButton).toBeVisible({ timeout: 30_000 });
  await deleteButton.click();

  await expect(page.getByText("Delete this meeting?")).toBeVisible();
  await page.getByRole("button", { name: "Delete permanently" }).click();

  await expect(deleteButton).toBeHidden({ timeout: 30_000 });

  // The cascade, checked where the data lives. The list hides the row as soon as the request is
  // accepted, so the storage side is polled rather than read once.
  await waitFor(async () => (await listKeys(prefix)).length === 0, 30_000, "the audio to be gone");
  expect(await listKeys(prefix)).toEqual([]);
  expect(await countRowsForSession("transcripts", sessionId)).toBe(0);
  expect(await countRowsForSession("summaries", sessionId)).toBe(0);
  expect(await countRowsForSession("jobs", sessionId)).toBe(0);

  const after = await page.request.get(meetingUrl, { headers: asAlice, failOnStatusCode: false });
  expect(after.status()).toBe(404);

  // Deleting again is a 404, not an error — which is what makes a retry after a crash safe.
  const again = await page.request.delete(meetingUrl, {
    headers: asAlice,
    failOnStatusCode: false,
  });
  expect(again.status()).toBe(404);
});
