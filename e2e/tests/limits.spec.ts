import {
  expect,
  recordButton,
  startRecording,
  stopRecording,
  test,
  waitForValue,
  watchRecordingProtocol,
} from "../fixtures.js";
import { devUsers, stackEnv } from "../support/env.js";
import { findSummary, findTranscript } from "../support/database.js";
import { fetchToken } from "../support/keycloak.js";
import { startSession, type RecordingSocket } from "../support/recording-socket.js";

/**
 * What a limit looks like to the user (CLAUDE.md — limits must not silently break a critical path).
 *
 * The limits themselves are unit-tested where they are counted, and the codes they travel as are a
 * typed contract. What no unit test can hold is the last hop: a refusal that reaches the browser as
 * a WebSocket close reason or a 429 body has to arrive on screen as a sentence a person can act on.
 * The regenerate incident is the reason this file exists — a refusal that renders as nothing, or as
 * a raw code, is indistinguishable from the product being broken.
 *
 * TWO DELIBERATE CHOICES ABOUT HOW THIS IS PROVOKED:
 *
 * Nothing here reconfigures the stack. Two of the shipped defaults are reachable by ordinary use —
 * three parallel sessions and the small per-window allowance for the one route that costs a model
 * call — so both refusals can be provoked against exactly the configuration the rest of the suite
 * runs on. Per-test limit configuration would mean a second stack or a restart between specs, and
 * it would mean the assertions no longer describe the numbers the product actually ships with.
 *
 * And everything runs as Bob rather than Alice. Both limits are metered per user, so a spec that
 * deliberately spends a user's allowance would otherwise leave the recording specs racing a
 * sixty-second window they never asked to be in. Bob's allowance is nobody else's.
 */

test("says so when a recording is refused for too many open sessions", async ({ page, signIn }) => {
  const bob = await fetchToken(devUsers.bob);
  const protocol = watchRecordingProtocol(page);

  // The shipped ceiling is three sessions per user, so three sockets hold it exactly full. They
  // are opened outside the browser because the product offers no way to run three at once — which
  // is the point of the limit, not a gap in it.
  const held: RecordingSocket[] = [];
  try {
    for (let index = 0; index < 3; index += 1) {
      const session = await startSession(bob.accessToken);
      held.push(session.socket);
    }

    await signIn(devUsers.bob);
    await page.goto("/record");
    await expect(page.getByTestId("consent-card")).toBeVisible();
    await recordButton(page).click();

    // The refusal is a close frame carrying a code, and this is where that code becomes a sentence:
    // what happened, and what to do about it. No raw `limit.parallel_sessions_exceeded` on screen,
    // and no reassurance that the recording is safe — nothing was recorded.
    const panel = page.getByRole("alert");
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel).toContainText(
      "You already have as many recordings running as your account",
    );
    await expect(panel).not.toContainText("limit.");
    await expect(panel).not.toContainText("finalized and safe");

    // The screen is not left pretending to record.
    await expect(page.getByTestId("hold-to-stop")).toHaveCount(0);
    expect(protocol.finalized).toBe(false);

    // And there is a way out of it that does not involve reloading the app.
    await page.getByRole("button", { name: "Back to meetings" }).click();
    await expect(page).toHaveURL(/\/meetings$/);
  } finally {
    // Closed *and* seen to be closed: the server releases the session slot when the socket goes
    // away, and the next spec records as this same user. Walking off without waiting would leave
    // it racing three sockets that are still counted.
    for (const socket of held) socket.dispose();
    for (const socket of held) await socket.closeInfo();
  }
});

/**
 * The refusal the regenerate incident was about, seen from the meeting screen.
 *
 * Asking for a summary again is the one request that buys a model call, so it carries its own small
 * per-window allowance. That allowance is spent here through the API with the same user's token —
 * the counter is per user, not per connection — and the button is then pressed in the browser, so
 * what is asserted is the browser's own refused request rendering as copy.
 */
test("says so when a summary is asked for again too often", async ({ page, signIn }) => {
  const bob = await fetchToken(devUsers.bob);
  const protocol = watchRecordingProtocol(page);

  await signIn(devUsers.bob);
  await page.goto("/record");
  await startRecording(page);
  const sessionId = await protocol.waitForSessionId();
  await protocol.waitForAck(2);
  await stopRecording(page);
  await protocol.waitForFinalized();

  const transcript = await waitForValue(
    () => findTranscript(sessionId),
    stackEnv.whisperMode === "real" ? 300_000 : 60_000,
    "the transcript row",
  );
  const summary = await waitForValue(() => findSummary(sessionId), 60_000, "the summary row");

  await page.goto(`/meetings/${transcript.meetingId}`);
  await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible({ timeout: 30_000 });

  // Spend the allowance. The number it holds is deliberately not written down here: it is
  // configuration, and a spec that hard-coded it would fail for the wrong reason the day an
  // operator changed it. What matters is that the allowance is finite and that the endpoint refuses
  // with the shared code once it is gone.
  //
  // Each request names a template that does not exist, which is enough to be counted and not enough
  // to be carried out: the limiter runs before the route ever looks at the body, so the allowance is
  // spent while no work is enqueued. Spending it on real regenerations would leave a queue of
  // summary jobs racing the specs that come after this one.
  const endpoint = `${stackEnv.apiUrl}/api/meetings/${transcript.meetingId}/summaries`;
  let refused = false;
  for (let attempt = 0; attempt < 40 && !refused; attempt += 1) {
    const response = await page.request.post(endpoint, {
      headers: { authorization: `Bearer ${bob.accessToken}`, "content-type": "application/json" },
      data: { templateId: "00000000-0000-4000-8000-000000000000" },
      failOnStatusCode: false,
    });
    if (response.status() === 429) {
      expect(await response.json()).toMatchObject({ error: "limit.request_rate_exceeded" });
      refused = true;
    }
  }
  expect(refused).toBe(true);
  // The summary that was already there is untouched by the spending above.
  expect((await findSummary(sessionId))?.id).toBe(summary.id);

  // The same refusal, now for a request the browser made itself.
  await page.getByRole("button", { name: "Regenerate" }).click();
  const alert = page.getByRole("alert");
  await expect(alert).toBeVisible({ timeout: 30_000 });
  await expect(alert).toContainText("Too many requests in a short time");
  await expect(alert).not.toContainText("limit.");

  // And the summary that was already there is still on screen: a refused request changed nothing.
  await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible();
});
