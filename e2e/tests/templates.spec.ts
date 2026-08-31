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
  findSummaries,
  findSummary,
  findTranscript,
  findUserTemplateId,
} from "../support/database.js";

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
  // The card previews the sections as an ordered list, so what the summary will contain is
  // visible in the order it will arrive in.
  await expect(card.getByRole("listitem").last()).toHaveText("Risks");

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
  // Nothing to open first: the summary and the transcript stand side by side, so the template
  // picker is on screen as soon as the meeting is.
  await expect(page.getByRole("heading", { name: "Summary" })).toBeVisible();

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

const DEFAULT_TEMPLATE_NAME = "E2E default layout";

/**
 * The same core path, but with the user's own template chosen up front: a recording is summarized
 * the way its owner asked for without anybody pressing "Regenerate" afterwards. The recording flow
 * itself is untouched — the choice is made on the templates screen, long before the microphone.
 */
test("summarizes a new recording with the template the user set as their default", async ({
  page,
  signIn,
}) => {
  const protocol = watchRecordingProtocol(page);
  await signIn(devUsers.alice);

  // --- A template, and the decision to summarize with it ---------------------------------------
  await page.goto("/templates");
  await page.getByRole("button", { name: "Create a template" }).first().click();
  await page.getByLabel("Name").fill(DEFAULT_TEMPLATE_NAME);
  await page.getByRole("button", { name: "Add a section" }).click();
  await page.getByLabel("Heading").last().fill("Budget");
  await page.getByLabel("What belongs in it").last().fill("Money that was talked about.");
  await page.getByRole("button", { name: "Save template" }).click();

  const card = page.getByTestId("template-card").filter({ hasText: DEFAULT_TEMPLATE_NAME });
  await expect(card).toBeVisible();

  const system = page.getByTestId("template-card").filter({ hasText: "Standard meeting summary" });
  // Until a choice is made the system template is the one recordings land on, and the list says so
  // rather than leaving the question open.
  await expect(system.getByTestId("template-default-badge")).toBeVisible();

  await card
    .getByRole("button", { name: `Default — use ${DEFAULT_TEMPLATE_NAME} for new recordings` })
    .click();
  await expect(card.getByTestId("template-default-badge")).toBeVisible();
  await expect(system.getByTestId("template-default-badge")).toHaveCount(0);

  const templateId = await waitForValue(
    () => findUserTemplateId(DEFAULT_TEMPLATE_NAME),
    10_000,
    "the stored template",
  );

  // --- A recording made afterwards -------------------------------------------------------------
  await page.goto("/record");
  await startRecording(page);
  const sessionId = await protocol.waitForSessionId();
  await protocol.waitForAck(3);
  await stopRecording(page);
  await protocol.waitForFinalized();

  await waitForValue(
    () => findTranscript(sessionId),
    stackEnv.whisperMode === "real" ? 300_000 : 60_000,
    "the transcript row",
  );

  // The first summary of this meeting — nobody regenerated anything — carries the user's template.
  const summary = await waitForValue(() => findSummary(sessionId), 60_000, "the first summary row");
  expect(summary.templateId).toBe(templateId);
  expect((await findSummaries(sessionId)).length).toBe(1);

  // --- Giving the choice up --------------------------------------------------------------------
  // Unsetting is not "no default": it hands the mark back to the system template, so a user is
  // never left without one.
  await page.goto("/templates");
  const chosen = page.getByTestId("template-card").filter({ hasText: DEFAULT_TEMPLATE_NAME });
  await chosen
    .getByRole("button", {
      name: `Default — stop using ${DEFAULT_TEMPLATE_NAME} for new recordings`,
    })
    .click();
  await expect(
    page
      .getByTestId("template-card")
      .filter({ hasText: "Standard meeting summary" })
      .getByTestId("template-default-badge"),
  ).toBeVisible();

  await chosen.getByRole("button", { name: `Delete ${DEFAULT_TEMPLATE_NAME}` }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete template" }).click();
  await expect(chosen).toHaveCount(0);
});

const PREFERRED_NAME = "E2E preferred layout";
const ONE_OFF_NAME = "E2E one-off layout";

/**
 * The top of the resolution chain: a template chosen for this one meeting before recording beats
 * the user's default. The choice is made on the recording screen, so the capture moment stays
 * one decision long — the select is prefilled and can simply be ignored.
 */
test("summarizes a recording with the template picked at the start, over the user's default", async ({
  page,
  signIn,
}) => {
  const protocol = watchRecordingProtocol(page);
  await signIn(devUsers.alice);

  // --- Two templates: one the user's default, one for this meeting only ------------------------
  await page.goto("/templates");
  for (const [name, section] of [
    [PREFERRED_NAME, "Usual"],
    [ONE_OFF_NAME, "Just this once"],
  ] as const) {
    await page.getByRole("button", { name: "Create a template" }).first().click();
    await page.getByLabel("Name").fill(name);
    await page.getByRole("button", { name: "Add a section" }).click();
    await page.getByLabel("Heading").last().fill(section);
    await page.getByLabel("What belongs in it").last().fill(`Whatever belongs under ${section}.`);
    await page.getByRole("button", { name: "Save template" }).click();
    await expect(page.getByTestId("template-card").filter({ hasText: name })).toBeVisible();
  }

  const preferred = page.getByTestId("template-card").filter({ hasText: PREFERRED_NAME });
  await preferred
    .getByRole("button", { name: `Default — use ${PREFERRED_NAME} for new recordings` })
    .click();
  // Waiting for the badge, not just for the click: the choice is a request, and the recording
  // screen below reads the answer to it. Navigating while it is still in flight leaves the picker
  // on the system template — which is exactly what CI caught, on a runner slow enough to lose the
  // race this spec was quietly running. Its sibling above already waits here.
  await expect(preferred.getByTestId("template-default-badge")).toBeVisible();

  const oneOffId = await waitForValue(
    () => findUserTemplateId(ONE_OFF_NAME),
    10_000,
    "the stored one-off template",
  );

  // --- Choosing at the start of a recording ----------------------------------------------------
  await page.goto("/record");
  const picker = page.getByLabel("Summary template");
  // Prefilled with the default, so a user who wants their usual layout touches nothing.
  await expect(picker).toHaveValue(
    (await findUserTemplateId(PREFERRED_NAME)) ?? "the default template",
  );

  await picker.selectOption({ label: ONE_OFF_NAME });

  await startRecording(page);
  const sessionId = await protocol.waitForSessionId();
  await protocol.waitForAck(3);
  await stopRecording(page);
  await protocol.waitForFinalized();

  await waitForValue(
    () => findTranscript(sessionId),
    stackEnv.whisperMode === "real" ? 300_000 : 60_000,
    "the transcript row",
  );

  // The first and only summary follows the one-off choice, not the default it overrode.
  const summary = await waitForValue(() => findSummary(sessionId), 60_000, "the first summary row");
  expect(summary.templateId).toBe(oneOffId);
  expect((await findSummaries(sessionId)).length).toBe(1);

  // --- Cleanup ---------------------------------------------------------------------------------
  await page.goto("/templates");
  await page
    .getByTestId("template-card")
    .filter({ hasText: PREFERRED_NAME })
    .getByRole("button", { name: `Default — stop using ${PREFERRED_NAME} for new recordings` })
    .click();

  for (const name of [PREFERRED_NAME, ONE_OFF_NAME]) {
    const doomed = page.getByTestId("template-card").filter({ hasText: name });
    await doomed.getByRole("button", { name: `Delete ${name}` }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete template" }).click();
    await expect(doomed).toHaveCount(0);
  }
});

const DOOMED_DEFAULT_NAME = "E2E doomed default layout";

/**
 * Deleting the template that is currently the default, which is the case the fallback exists for.
 *
 * The spec above gives the choice up first and then deletes an ordinary template; nothing checked
 * what happens when the row a user's settings point at simply disappears. The promise is that a
 * user is never left without a default: the mark goes back to the system template, and it goes
 * back on the server rather than only in the list that happens to be on screen — so the page is
 * reloaded before the assertion, which is what tells a stored fallback apart from a rendered one.
 */
test("hands the default back to the system template when the chosen one is deleted", async ({
  page,
  signIn,
}) => {
  await signIn(devUsers.alice);
  await page.goto("/templates");

  await page.getByRole("button", { name: "Create a template" }).first().click();
  await page.getByLabel("Name").fill(DOOMED_DEFAULT_NAME);
  await page.getByRole("button", { name: "Add a section" }).click();
  await page.getByLabel("Heading").last().fill("Anything");
  await page.getByLabel("What belongs in it").last().fill("Whatever was said.");
  await page.getByRole("button", { name: "Save template" }).click();

  const card = page.getByTestId("template-card").filter({ hasText: DOOMED_DEFAULT_NAME });
  await expect(card).toBeVisible();

  await card
    .getByRole("button", { name: `Default — use ${DOOMED_DEFAULT_NAME} for new recordings` })
    .click();
  await expect(card.getByTestId("template-default-badge")).toBeVisible();

  // Deleted while it is still the default — no unsetting first, which is the whole point.
  await card.getByRole("button", { name: `Delete ${DOOMED_DEFAULT_NAME}` }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete template" }).click();
  await expect(card).toHaveCount(0);

  await page.reload();
  await expect(
    page.getByTestId("template-card").filter({ hasText: DOOMED_DEFAULT_NAME }),
  ).toHaveCount(0);
  await expect(
    page
      .getByTestId("template-card")
      .filter({ hasText: "Standard meeting summary" })
      .getByTestId("template-default-badge"),
  ).toBeVisible();
});
