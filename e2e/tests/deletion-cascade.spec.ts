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
import { countRowsForSession, findSummary, findTranscript } from "../support/database.js";
import { listKeys, sessionPrefix } from "../support/storage.js";

/**
 * Critical path: deleting a meeting completely — audio, transcripts, summaries and jobs
 * (CLAUDE.md, ADR-001).
 *
 * Deletion has an API but no screen yet, so this drives the endpoint with a real user's token
 * instead of a browser. Everything up to the deletion goes through the UI, so what is deleted is
 * a genuinely recorded meeting with a transcript and a summary hanging off it, not a fixture.
 */

test("deletes a meeting and everything derived from it", async ({ page, signIn }) => {
  const alice = await fetchToken(devUsers.alice);
  const carol = await fetchToken(devUsers.carol);
  const protocol = watchRecordingProtocol(page);

  await signIn(devUsers.alice);
  await page.goto("/record");
  await startRecording(page);
  const sessionId = await protocol.waitForSessionId();
  await protocol.waitForAck(2);
  await stopRecording(page);
  await protocol.waitForFinalized();

  const meetingId = protocol.meetingId as string;
  expect(meetingId).toBeTruthy();

  // Wait until the whole pipeline has run: deleting a meeting mid-flight would prove less.
  await waitForValue(() => findTranscript(sessionId), 60_000, "the transcript row");
  await waitForValue(() => findSummary(sessionId), 60_000, "the summary row");

  const prefix = sessionPrefix({
    tenantId: alice.tenantId,
    userId: alice.userId,
    sessionId,
  });
  expect((await listKeys(prefix)).length).toBeGreaterThan(0);

  const meetingUrl = `${stackEnv.apiUrl}/api/meetings/${meetingId}`;
  const asAlice = { authorization: `Bearer ${alice.accessToken}` };

  const before = await page.request.get(meetingUrl, { headers: asAlice });
  expect(before.status()).toBe(200);

  // Another tenant cannot delete it, and is told nothing about its existence.
  const intruder = await page.request.delete(meetingUrl, {
    headers: { authorization: `Bearer ${carol.accessToken}` },
    failOnStatusCode: false,
  });
  expect(intruder.status()).toBe(404);
  expect((await listKeys(prefix)).length).toBeGreaterThan(0);

  const deleted = await page.request.delete(meetingUrl, { headers: asAlice });
  expect(deleted.status()).toBe(204);

  // The cascade: no audio left under the session prefix, and no derived rows anywhere.
  expect(await listKeys(prefix)).toEqual([]);
  expect(await countRowsForSession("transcripts", sessionId)).toBe(0);
  expect(await countRowsForSession("summaries", sessionId)).toBe(0);
  expect(await countRowsForSession("jobs", sessionId)).toBe(0);

  const after = await page.request.get(meetingUrl, { headers: asAlice, failOnStatusCode: false });
  expect(after.status()).toBe(404);

  // Deletion is idempotent, which is what makes a retry after a crash safe.
  const again = await page.request.delete(meetingUrl, {
    headers: asAlice,
    failOnStatusCode: false,
  });
  expect(again.status()).toBe(404);
});
