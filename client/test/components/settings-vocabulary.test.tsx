import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MAX_VOCABULARY_TERMS, MAX_VOCABULARY_TERM_LENGTH } from "@quorum/shared";
import { renderWithProviders, useLanguage } from "./render";

/**
 * The vocabulary subpage: a flat list, a field to add a term, a delete per entry, and a limit the
 * screen refuses to go past.
 *
 * The store is mocked because the subject is the screen's behavior at the limit and around a
 * failed save — the API has its own tests. What is *not* mocked is the shared decision about
 * whether a term fits: the screen and the server have to agree on that exactly, so the test runs
 * the real rule.
 */
vi.mock("@/features/auth/auth-provider", () => ({
  useAuth: () => ({
    user: { profile: { name: "Maria Winter" } },
    signOut: async () => undefined,
    accessToken: "stub",
  }),
}));

/** Refusals are reported as a toast, which renders outside this tree — so the toast is the seam. */
const failure = vi.hoisted(() => vi.fn((_message: string) => undefined));

vi.mock("@/lib/toast", () => ({ notify: { success: vi.fn(), failure } }));

const saveVocabulary = vi.hoisted(() => vi.fn(async (_terms: readonly string[]) => undefined));
const vocabulary = vi.hoisted(() => ({ current: [] as string[] }));
const saving = vi.hoisted(() => ({ current: false }));

vi.mock("@/features/settings/use-user-settings", () => ({
  useUserSettings: () => ({
    settings: { transcriptionLanguage: null, vocabulary: vocabulary.current },
    status: "ready",
    saving: saving.current,
    chooseTranscriptionLanguage: async () => undefined,
    saveVocabulary,
  }),
}));

const { SettingsVocabularyRoute } = await import("@/routes/settings-vocabulary");

function renderSettings() {
  renderWithProviders(<SettingsVocabularyRoute />, { route: "/settings/vocabulary" });
}

async function addTerm(term: string) {
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Add a term"), term);
  await user.click(screen.getByRole("button", { name: "Add" }));
}

describe("the vocabulary subpage", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  beforeEach(() => {
    saveVocabulary.mockClear();
    failure.mockClear();
    saveVocabulary.mockImplementation(async () => undefined);
    vocabulary.current = [];
    saving.current = false;
  });

  afterEach(async () => {
    await useLanguage("en");
  });

  it("carries the whole explanation, which settings no longer repeats", async () => {
    renderSettings();

    expect(screen.getByRole("heading", { level: 1, name: "Vocabulary" })).toBeVisible();
    // The one thing a user cannot discover by trying it: nothing already transcribed changes.
    expect(screen.getByText(/applies to future recordings only/i)).toBeVisible();
  });

  it("offers the way back to settings", async () => {
    // The page is reached from a settings row and the top bar has no pill for it, so the back
    // link is the only way out that does not go through browser history.
    renderSettings();

    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });

  it("adds a term and hands the whole list to the store", async () => {
    vocabulary.current = ["Ansible"];
    renderSettings();

    await addTerm("MinIO");

    expect(saveVocabulary).toHaveBeenCalledWith(["Ansible", "MinIO"]);
  });

  it("clears the field once the term is on its way", async () => {
    renderSettings();

    await addTerm("MinIO");

    expect(screen.getByLabelText("Add a term")).toHaveValue("");
  });

  it("puts the term back in the field when the save fails", async () => {
    // Otherwise the term is simply gone: not in the list, not in the field, with only a toast to
    // say so.
    saveVocabulary.mockRejectedValueOnce(new Error("offline"));
    renderSettings();

    await addTerm("MinIO");

    expect(screen.getByLabelText("Add a term")).toHaveValue("MinIO");
  });

  it("does not clobber what the user typed next when a slow save fails", async () => {
    // The failed term is worth restoring, but not at the cost of the one being typed now.
    let reject: (error: Error) => void = () => undefined;
    saveVocabulary.mockImplementationOnce(
      () => new Promise((_resolve, r) => (reject = () => r(new Error("offline")))),
    );
    const user = userEvent.setup();
    renderSettings();

    await user.type(screen.getByLabelText("Add a term"), "MinIO");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.type(screen.getByLabelText("Add a term"), "Ansible");
    reject(new Error("offline"));

    await waitFor(() => expect(failure).toHaveBeenCalled());
    expect(screen.getByLabelText("Add a term")).toHaveValue("Ansible");
  });

  it("shows every stored term with a delete action of its own", async () => {
    vocabulary.current = ["Ansible", "MinIO"];
    renderSettings();

    expect(screen.getByText("Ansible")).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "Remove Ansible" }));

    expect(saveVocabulary).toHaveBeenCalledWith(["MinIO"]);
  });

  it("counts what is stored against the limit", async () => {
    vocabulary.current = ["Ansible", "MinIO"];
    renderSettings();

    expect(screen.getByText(`2 of ${MAX_VOCABULARY_TERMS} terms`)).toBeVisible();
  });

  it("refuses a term once the list is full, and stores nothing", async () => {
    // The limit is the point: a term the screen accepted but the backend would silently drop is
    // worse than a term the screen refused.
    vocabulary.current = Array.from({ length: MAX_VOCABULARY_TERMS }, (_, i) => `Term${i}`);
    renderSettings();

    await addTerm("MinIO");

    expect(saveVocabulary).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledWith(expect.stringContaining("The list is full"));
  });

  it("refuses a duplicate rather than spending a slot on it", async () => {
    vocabulary.current = ["Keycloak"];
    renderSettings();

    await addTerm("keycloak");

    expect(saveVocabulary).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledWith(expect.stringContaining("already on the list"));
  });

  it("says when the room has run out rather than the count", async () => {
    // Two different ways to be full, and the remedy is only obvious if the message says which.
    vocabulary.current = Array.from({ length: 15 }, (_, i) => `${"A".repeat(30)}${i}`);
    renderSettings();

    await addTerm("MinIO");

    expect(saveVocabulary).not.toHaveBeenCalled();
    expect(failure).toHaveBeenCalledWith(expect.stringContaining("no room left"));
  });

  it("does not let a term be typed past the length one entry may be", async () => {
    renderSettings();

    expect(screen.getByLabelText("Add a term")).toHaveAttribute(
      "maxLength",
      String(MAX_VOCABULARY_TERM_LENGTH),
    );
  });

  it("says nothing when enter is pressed on an empty field", async () => {
    renderSettings();

    await userEvent.setup().type(screen.getByLabelText("Add a term"), "{Enter}");

    expect(saveVocabulary).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
  });

  it("locks the controls while a save is in flight", async () => {
    vocabulary.current = ["Ansible"];
    saving.current = true;
    renderSettings();

    expect(screen.getByLabelText("Add a term")).toBeDisabled();
    expect(screen.getByRole("button", { name: "Remove Ansible" })).toBeDisabled();
  });

  it("translates the whole page", async () => {
    vocabulary.current = ["Ansible"];
    await useLanguage("de");
    renderSettings();

    expect(screen.getByRole("heading", { level: 1, name: "Fachbegriffe" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Einstellungen" })).toBeVisible();
    expect(screen.getByText(`1 von ${MAX_VOCABULARY_TERMS} Begriffen`)).toBeVisible();
    expect(screen.getByRole("button", { name: "Ansible entfernen" })).toBeVisible();
  });
});
