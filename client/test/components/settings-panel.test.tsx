import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, useLanguage } from "./render";

/**
 * Settings as one panel of rows. Auth is replaced because a real session is not what this is
 * about — the questions are whether each setting still names itself once the four card headings
 * are gone, and whether the pills still express a choice between mutually exclusive options.
 */
const signOut = vi.fn(async () => undefined);
const profile = vi.hoisted(() => ({ current: { name: "Maria Winter" } as Record<string, string> }));

vi.mock("@/features/auth/auth-provider", () => ({
  useAuth: () => ({ user: { profile: profile.current }, signOut, accessToken: "stub" }),
}));

/** The stored preferences, and what the screen did to them — the API itself is not the subject. */
const chooseTranscriptionLanguage = vi.fn(async () => undefined);
const transcriptionLanguage = vi.hoisted(() => ({ current: null as string | null }));

vi.mock("@/features/settings/use-user-settings", () => ({
  useUserSettings: () => ({
    settings: { transcriptionLanguage: transcriptionLanguage.current },
    status: "ready",
    saving: false,
    chooseTranscriptionLanguage,
  }),
}));

const { SettingsRoute } = await import("@/routes/settings");
const { ThemeProvider } = await import("@/features/theme/theme-provider");

function renderSettings() {
  renderWithProviders(
    <ThemeProvider>
      <SettingsRoute />
    </ThemeProvider>,
  );
}

describe("settings panel", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  beforeEach(() => {
    signOut.mockClear();
    chooseTranscriptionLanguage.mockClear();
    transcriptionLanguage.current = null;
    profile.current = { name: "Maria Winter" };
    window.localStorage.clear();
  });

  afterEach(async () => {
    await useLanguage("en");
  });

  it("names every setting, so nothing is lost with the card headings", () => {
    renderSettings();

    // The uppercase row labels are the panel's structure now: one heading per setting, with what
    // a user came here to change first and the account last.
    expect(screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent)).toEqual([
      "Appearance",
      "Language",
      "Transcription",
      "About",
      "Account",
    ]);
    expect(screen.getByText("Maria Winter")).toBeInTheDocument();
    expect(screen.getByText(/Your recordings, transcripts and summaries/)).toBeInTheDocument();
  });

  it("closes the panel with the account, under the settings it would interrupt", () => {
    renderSettings();

    const rows = document.querySelectorAll("section");
    const last = rows[rows.length - 1] as HTMLElement;
    // Who is signed in is a fact to check and signing out ends the session — neither is what a
    // user opened this screen to change, so both come after the preferences.
    expect(within(last).getByRole("heading", { level: 2 })).toHaveTextContent("Account");
    expect(within(last).getByText("Maria Winter")).toBeVisible();
    expect(within(last).getByRole("button", { name: "Sign out" })).toBeVisible();
  });

  it("offers theme and language as one choice each, not as loose toggles", () => {
    renderSettings();

    const theme = screen.getByRole("radiogroup", { name: "Theme" });
    expect(
      within(theme)
        .getAllByRole("radio")
        .map((pill) => pill.textContent),
    ).toEqual(["Match system", "Light", "Dark"]);
    // Untouched, the app follows the operating system — and the group says which one is in effect
    // rather than leaving all three unchecked.
    expect(within(theme).getByRole("radio", { name: "Match system" })).toBeChecked();

    const language = screen.getByRole("radiogroup", { name: "Interface language" });
    expect(within(language).getByRole("radio", { name: "English" })).toBeChecked();
  });

  it("switches the theme on a pill", async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getByRole("radio", { name: "Dark" }));

    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Match system" })).not.toBeChecked();
    expect(document.documentElement).toHaveClass("dark");
  });

  it("switches the interface language on a pill", async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getByRole("radio", { name: "Deutsch" }));

    // The whole screen follows, which is the only proof the change reached i18n rather than just
    // the pill's own state.
    expect(await screen.findByRole("heading", { name: "Einstellungen" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Deutsch" })).toBeChecked();
  });

  it("keeps the transcription default apart from the language of the screen", () => {
    renderSettings();

    // Two different settings with the same word in them, so the test says which is which: the
    // pills change the interface, the select decides what new recordings are transcribed in.
    expect(screen.getByRole("radiogroup", { name: "Interface language" })).toBeInTheDocument();
    const language = screen.getByLabelText("Language of new recordings");
    // Nothing chosen is its own option, not a synonym for detection: it leaves the decision to
    // however this installation is configured.
    expect(language).toHaveValue("");
    expect(
      Array.from(language.querySelectorAll("option")).map((option) => option.textContent),
    ).toEqual([
      "Not chosen",
      "Detect automatically",
      "German",
      "English",
      "French",
      "Spanish",
      "Italian",
      "Dutch",
      "Portuguese",
    ]);
  });

  it("stores the language new recordings start out in", async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.selectOptions(screen.getByLabelText("Language of new recordings"), "de");

    expect(chooseTranscriptionLanguage).toHaveBeenCalledWith("de");
  });

  it("shows the stored default, and can give it up again", async () => {
    const user = userEvent.setup();
    transcriptionLanguage.current = "de";
    renderSettings();

    expect(screen.getByLabelText("Language of new recordings")).toHaveValue("de");

    await user.selectOptions(screen.getByLabelText("Language of new recordings"), "");
    expect(chooseTranscriptionLanguage).toHaveBeenCalledWith(null);
  });

  it("signs out, and says so while it is happening", async () => {
    const user = userEvent.setup();
    renderSettings();

    await user.click(screen.getByRole("button", { name: "Sign out" }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it("can still be signed out of when the token carries no readable name", () => {
    profile.current = {};
    renderSettings();

    expect(screen.getByRole("button", { name: "Sign out" })).toBeInTheDocument();
  });
});
