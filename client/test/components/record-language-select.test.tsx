import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, stubRecordingSession, useLanguage } from "./render";

/**
 * The language indicator on the start stage. The microphone, the socket and the template list are
 * all replaced: what this is about is which language the screen shows and which one the recording
 * is then started with.
 */
const startSpy = vi.hoisted(() => vi.fn());
const stored = vi.hoisted(() => ({ current: null as string | null }));
/** The window before the stored default has arrived, which the resting state has to survive. */
const loading = vi.hoisted(() => ({ current: false }));

vi.mock("@/features/settings/use-user-settings", () => ({
  useUserSettings: () => ({
    settings: { transcriptionLanguage: loading.current ? null : stored.current },
    status: loading.current ? "loading" : "ready",
    saving: false,
    chooseTranscriptionLanguage: async () => undefined,
  }),
}));

vi.mock("@/features/templates/use-templates", () => ({
  useTemplates: () => ({
    templates: [],
    status: "ready",
    errorCode: null,
    saving: false,
    reload: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    chooseDefault: vi.fn(),
  }),
}));

const { RecordRoute } = await import("@/routes/record");

const LANGUAGE_LABEL = "Spoken language";
const RECORD_BUTTON = "I have informed the participants — start recording";

function renderStage() {
  renderWithProviders(<RecordRoute />, { recording: stubRecordingSession({ start: startSpy }) });
}

describe("the language a meeting is recorded in", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  beforeEach(() => {
    startSpy.mockClear();
    stored.current = null;
    loading.current = false;
  });

  it("is always on the stage, unlike the template picker", () => {
    renderStage();

    // Every recording has a language, and the one meeting held in another one is exactly the
    // meeting this has to be reachable for — so it does not wait for the user to own two of
    // something the way the template picker does.
    expect(screen.getByLabelText(LANGUAGE_LABEL)).toBeInTheDocument();
  });

  it("rests on following the default, which is not the same as asking for detection", () => {
    renderStage();

    // The resting option says what actually happens — the account decides, and below it the
    // installation. Resting on "detect" would claim detection on a stack configured for one
    // language, and would leave detection itself unreachable: selecting the option already on
    // screen fires no change at all.
    expect(screen.getByLabelText<HTMLSelectElement>(LANGUAGE_LABEL).value).toBe("");
    expect(screen.getByRole("option", { name: "Default" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Detect automatically" })).toBeInTheDocument();
  });

  it("rests on following the default while the stored one is still loading", () => {
    loading.current = true;
    renderStage();

    // The screen has not read the default yet, so the only honest thing it can state is that it
    // is following it — and a recording started in that instant is resolved from the server's
    // copy rather than from a screen that has not seen it.
    expect(screen.getByLabelText<HTMLSelectElement>(LANGUAGE_LABEL).value).toBe("");
  });

  it("opens on the user's default", () => {
    stored.current = "de";
    renderStage();

    expect(screen.getByLabelText<HTMLSelectElement>(LANGUAGE_LABEL).value).toBe("de");
  });

  it("keeps a choice made for this meeting, even against the default", async () => {
    const user = userEvent.setup();
    stored.current = "de";
    renderStage();

    const select = screen.getByLabelText<HTMLSelectElement>(LANGUAGE_LABEL);
    await user.selectOptions(select, "fr");

    // Once touched, the field is the user's; the default must not reclaim it on a later render.
    expect(select.value).toBe("fr");
  });

  it("starts the recording in the language that was on screen", async () => {
    const user = userEvent.setup();
    stored.current = "de";
    renderStage();

    await user.selectOptions(screen.getByLabelText(LANGUAGE_LABEL), "fr");
    await user.click(screen.getByRole("button", { name: RECORD_BUTTON }));

    expect(startSpy).toHaveBeenCalledWith(null, null, null, "in-person", "fr");
  });

  it("states the prefilled default rather than sending nothing", async () => {
    const user = userEvent.setup();
    stored.current = "de";
    renderStage();

    await user.click(screen.getByRole("button", { name: RECORD_BUTTON }));

    // What the screen showed when the recording started is what the meeting is transcribed in,
    // even if the user changes their default a minute later.
    expect(startSpy).toHaveBeenCalledWith(null, null, null, "in-person", "de");
  });

  it("states nothing when the picker was never touched and there is no default", async () => {
    const user = userEvent.setup();
    renderStage();

    await user.click(screen.getByRole("button", { name: RECORD_BUTTON }));

    // An installation configured for one language must still get that language here — it is the
    // link below the user's default, and claiming detection would silently overrule it for
    // everyone who never opened settings.
    expect(startSpy).toHaveBeenCalledWith(null, null, null, "in-person", null);
  });

  it("can ask for detection from the resting state, without toggling away and back", async () => {
    const user = userEvent.setup();
    renderStage();

    await user.selectOptions(screen.getByLabelText(LANGUAGE_LABEL), "auto");
    await user.click(screen.getByRole("button", { name: RECORD_BUTTON }));

    // Detection has to be reachable in one move from where the picker rests. It is a decision,
    // not silence: sending nothing would let the installation's language override what the user
    // just asked for.
    expect(startSpy).toHaveBeenCalledWith(null, null, null, "in-person", "auto");
  });

  it("asks for detection explicitly over a stored default", async () => {
    const user = userEvent.setup();
    stored.current = "de";
    renderStage();

    await user.selectOptions(screen.getByLabelText(LANGUAGE_LABEL), "auto");
    await user.click(screen.getByRole("button", { name: RECORD_BUTTON }));

    expect(startSpy).toHaveBeenCalledWith(null, null, null, "in-person", "auto");
  });

  it("can go back to following the default without the control snapping to its name", async () => {
    const user = userEvent.setup();
    stored.current = "de";
    renderStage();

    const select = screen.getByLabelText<HTMLSelectElement>(LANGUAGE_LABEL);
    await user.selectOptions(select, "");

    // Deliberately following the default is a third state, not a return to untouched: collapsing
    // the two would redisplay "German" the instant somebody chose to follow it.
    expect(select.value).toBe("");

    await user.click(screen.getByRole("button", { name: RECORD_BUTTON }));
    expect(startSpy).toHaveBeenCalledWith(null, null, null, "in-person", null);
  });

  it("stops taking a language once the recording is starting", () => {
    // Past the button press the session is already being opened with what the screen said. A
    // control that still moved would collect a choice that can never reach `session.start`.
    renderWithProviders(<RecordRoute />, {
      recording: stubRecordingSession({ start: startSpy, state: { phase: "requesting" } }),
    });

    expect(screen.getByLabelText(LANGUAGE_LABEL)).toBeDisabled();
  });

  it("names the languages in the reader's language", async () => {
    renderStage();
    expect(screen.getByRole("option", { name: "Detect automatically" })).toBeInTheDocument();

    await useLanguage("de");
    expect(screen.getByRole("option", { name: "Automatisch erkennen" })).toBeInTheDocument();
    await useLanguage("en");
  });
});
