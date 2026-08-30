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
import { findSummaries, findSummary, findTranscript } from "../support/database.js";

/**
 * Critical path 1 continued: a user's own template, and a summary produced again with it.
 *
 * The summary is part of the core path, so the template that shapes it belongs in the suite. What
 * is asserted is the chain and the scoping — the summary backend in the stack is a stub, so the
 * wording of a summary is never the subject.
 */

const TEMPLATE_NAME = "E2E layout";

test("shapes a template and summarizes an existing recording again with it", async ({
  page,
  signIn,
}) => {
  const alice = await fetchToken(devUsers.alice);
  const protocol = watchRecordingProtocol(page);

  await signIn(devUsers.alice);

  // --- The template ------------------------------------------------------------------------
  await page.goto("/templates");
  await page.getByRole("button", { name: "Create a template" }).first().click();

  await page.getByLabel("Name").fill(TEMPLATE_NAME);

  // The editor opens on the system template's sections; dropping one and adding another is the
  // override model of ADR-004 seen from the user's side.
  await page
    .getByRole("button", { name: /^Remove / })
    .first()
    .click();
  await page.getByRole("button", { name: "Add a section" }).click();

  const headings = page.getByLabel("Heading");
  await headings.last().fill("Risks");
  await page.getByLabel("What belongs in it").last().fill("Named risks only, one per bullet.");

  // The preview reflects the list as it stands, before anything is stored.
  await expect(page.getByRole("region", { name: "Preview" })).toContainText("Risks");

  await page.getByRole("button", { name: "Save template" }).click();

  const card = page.getByTestId("template-card").filter({ hasText: TEMPLATE_NAME });
  await expect(card).toBeVisible();
  await expect(card).toContainText("Risks");

  // --- A meeting to summarize --------------------------------------------------------------
  await page.goto("/record");
  await startRecording(page);
  const sessionId = await protocol.waitForSessionId();
  await protocol.waitForAck(3);
  await stopRecording(page);
  await protocol.waitForFinalized();

  const transcript = await waitForValue(
    () => findTranscript(sessionId),
    stackEnv.whisperMode === "real" ? 300_000 : 60_000,
    "the transcript row",
  );
  const first = await waitForValue(() => findSummary(sessionId), 60_000, "the first summary row");
  expect(first.tenantId).toBe(alice.tenantId);

  // --- Regenerating with the user's template -------------------------------------------------
  await page.goto(`/meetings/${transcript.meetingId}`);
  await page.getByRole("tab", { name: "Summary" }).click();

  await page.getByLabel("Template").selectOption({ label: TEMPLATE_NAME });
  await page.getByRole("button", { name: "Regenerate" }).click();

  // A second summary appears, made with the user's template rather than the system one, and the
  // first one is still there: a meeting has one active summary per template, not one in total.
  const second = await waitForValue(
    async () => {
      const all = await findSummaries(sessionId);
      return all.find((summary) => summary.templateId !== first.templateId) ?? null;
    },
    120_000,
    "a summary produced with the user's template",
  );
  expect(second.transcriptId).toBe(transcript.id);
  expect(second.meetingId).toBe(transcript.meetingId);
  expect(second.tenantId).toBe(alice.tenantId);
  expect(second.userId).toBe(alice.userId);
  expect(second.isActive).toBe(true);

  await waitFor(
    async () => (await findSummaries(sessionId)).some((summary) => summary.id === first.id),
    5_000,
    "the summary made with the system template to still exist",
  );

  // And the screen shows the new sections rather than the ones the template dropped.
  await expect(page.getByRole("heading", { name: "Risks" })).toBeVisible({ timeout: 30_000 });

  // --- Deleting the template -----------------------------------------------------------------
  // Destructive controls ask first, and the answer is not assumed: cancelling has to leave the
  // template exactly where it was.
  await page.goto("/templates");
  const doomed = page.getByTestId("template-card").filter({ hasText: TEMPLATE_NAME });
  await doomed.getByRole("button", { name: `Delete ${TEMPLATE_NAME}` }).click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Delete this template?");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(doomed).toBeVisible();

  await doomed.getByRole("button", { name: `Delete ${TEMPLATE_NAME}` }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete template" }).click();
  await expect(doomed).toHaveCount(0);

  // The summary made with it survives its template — that is what the snapshot is for.
  const survivors = await findSummaries(sessionId);
  expect(survivors.some((summary) => summary.id === second.id)).toBe(true);
});
