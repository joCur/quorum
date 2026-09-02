import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, stubRecordingSession, useLanguage } from "./render";

/**
 * The capture-mode choice on the recording start stage.
 *
 * Two things are being pinned here, and only one of them is behavior. The first is that the choice
 * reaches capture at all — the mode the stage showed is the mode the recording runs in. The second
 * is the copy, which for this feature is not decoration: "we only take the sound" is the sentence
 * the online mode asks the user to believe, and a test that lets it disappear is a test that lets
 * the promise disappear.
 */
const startSpy = vi.hoisted(() => vi.fn());

vi.mock("@/features/settings/use-user-settings", () => ({
  useUserSettings: () => ({
    settings: { transcriptionLanguage: null },
    status: "ready",
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

const MODE_KEY = "quorum.recording.capture-mode";

/** Gives the browser a screen-capture API, or takes it away. */
function setDisplayCapture(supported: boolean): void {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: vi.fn(async () => []),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      ...(supported ? { getDisplayMedia: vi.fn() } : {}),
    },
  });
}

function startButton(): HTMLElement {
  return screen.getByRole("button", { name: /start recording/i });
}

describe("choosing what kind of meeting is being recorded", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  beforeEach(() => {
    startSpy.mockClear();
    window.localStorage.removeItem(MODE_KEY);
    setDisplayCapture(true);
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "mediaDevices");
  });

  it("opens on the in-person mode, which is what most recordings are", () => {
    renderWithProviders(<RecordRoute />, { recording: stubRecordingSession({ start: startSpy }) });

    expect(screen.getByTestId("capture-mode-in-person")).toHaveAttribute("aria-checked", "true");
    expect(screen.getByTestId("capture-mode-online")).toHaveAttribute("aria-checked", "false");
  });

  it("is a radiogroup, so assistive technology hears one choice out of two", () => {
    renderWithProviders(<RecordRoute />, { recording: stubRecordingSession({ start: startSpy }) });

    const group = screen.getByRole("radiogroup", { name: "What kind of meeting is this?" });
    expect(group).toBe(screen.getByTestId("capture-mode-switch"));
    expect(screen.getAllByRole("radio")).toHaveLength(2);
  });

  it("starts the recording in the mode that was on screen", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RecordRoute />, { recording: stubRecordingSession({ start: startSpy }) });

    await user.click(screen.getByTestId("capture-mode-online"));
    await user.click(startButton());

    expect(startSpy).toHaveBeenCalledWith(null, null, null, "online", null);
  });

  it("remembers the mode, because the way someone meets rarely changes by the day", async () => {
    const user = userEvent.setup();
    const first = renderWithProviders(<RecordRoute />, {
      recording: stubRecordingSession({ start: startSpy }),
    });
    await user.click(screen.getByTestId("capture-mode-online"));
    first.unmount();

    renderWithProviders(<RecordRoute />, { recording: stubRecordingSession({ start: startSpy }) });
    expect(screen.getByTestId("capture-mode-online")).toHaveAttribute("aria-checked", "true");
  });

  it("says what the online mode listens to, and what it throws away", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RecordRoute />, { recording: stubRecordingSession({ start: startSpy }) });

    await user.click(screen.getByTestId("capture-mode-online"));

    const note = screen.getByTestId("capture-mode-note");
    // The promise, stated on the stage rather than only kept in the code.
    expect(note).toHaveTextContent("Quorum takes only the sound");
    expect(note).toHaveTextContent(/discarded/i);
    expect(note).toHaveTextContent(/never recorded, stored or transmitted/i);
    // And the one thing the user has to do in a dialog Quorum does not control.
    expect(note).toHaveTextContent(/share (tab audio|system audio)/i);
  });

  it("names both participants in the consent notice once the meeting is online", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RecordRoute />, { recording: stubRecordingSession({ start: startSpy }) });

    expect(screen.getByTestId("consent-card")).toHaveTextContent("all participants");

    await user.click(screen.getByTestId("capture-mode-online"));
    expect(screen.getByTestId("consent-card")).toHaveTextContent("everyone in the call");
  });
});

describe("a browser that cannot capture another app's sound", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  beforeEach(() => {
    startSpy.mockClear();
    window.localStorage.removeItem(MODE_KEY);
    setDisplayCapture(false);
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "mediaDevices");
  });

  it("explains what it cannot do instead of offering a button that would fail", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RecordRoute />, { recording: stubRecordingSession({ start: startSpy }) });

    await user.click(screen.getByTestId("capture-mode-online"));

    const note = screen.getByTestId("capture-mode-note");
    expect(note).toHaveTextContent("This browser cannot capture the sound of another app");
    // The realistic ways out, named — not a shrug.
    expect(note).toHaveTextContent(/Chrome or Edge/);
    expect(note).toHaveTextContent(/speakers/i);
  });

  it("refuses the start next to the reason rather than somewhere the user has to look for it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RecordRoute />, { recording: stubRecordingSession({ start: startSpy }) });

    await user.click(screen.getByTestId("capture-mode-online"));

    expect(startButton()).toBeDisabled();
    await user.click(startButton());
    expect(startSpy).not.toHaveBeenCalled();

    // In person still works on exactly this browser, and the button says so again immediately.
    await user.click(screen.getByTestId("capture-mode-in-person"));
    expect(startButton()).toBeEnabled();
  });
});

describe("what the screen says when the share goes wrong", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "mediaDevices");
  });

  it("explains a dismissed picker as a share that did not happen", () => {
    renderWithProviders(<RecordRoute />, {
      recording: stubRecordingSession({
        state: { phase: "error", error: { kind: "display-denied" } },
      }),
    });

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Nothing was shared, so nothing was recorded",
    );
  });

  it("names the checkbox when the share came back silent", () => {
    renderWithProviders(<RecordRoute />, {
      recording: stubRecordingSession({
        state: { phase: "error", error: { kind: "display-no-audio" } },
      }),
    });

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("That share carried no sound");
    expect(alert).toHaveTextContent(/tick .Also share tab audio. or .Share system audio./);
    // And a way forward for a platform that simply has no such option.
    expect(alert).toHaveTextContent(/record this meeting in person/i);
  });

  it("says which browsers can do it when this one cannot", () => {
    renderWithProviders(<RecordRoute />, {
      recording: stubRecordingSession({
        state: { phase: "error", error: { kind: "display-unsupported" } },
      }),
    });

    expect(screen.getByRole("alert")).toHaveTextContent(/macOS 14.2 or newer/);
  });
});

describe("a share the user stopped from the browser's own control", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "mediaDevices");
  });

  it("says the recording is paused and safe, not that it failed", () => {
    renderWithProviders(<RecordRoute />, {
      recording: stubRecordingSession({
        state: { phase: "paused", mode: "online", displayEnded: true },
      }),
    });

    const notice = screen.getByTestId("display-ended-notice");
    expect(notice).toHaveTextContent("The shared sound stopped");
    expect(notice).toHaveTextContent(/everything so far is safe/i);
    // A paused recording is not a failure and is not rendered as one.
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("tells the user that resuming will ask to share again", () => {
    renderWithProviders(<RecordRoute />, {
      recording: stubRecordingSession({
        state: { phase: "paused", mode: "online", displayEnded: true },
      }),
    });

    expect(screen.getByRole("button", { name: "Share again and resume" })).toBeInTheDocument();
  });

  it("keeps the plain resume label for an ordinary pause", () => {
    renderWithProviders(<RecordRoute />, {
      recording: stubRecordingSession({ state: { phase: "paused", mode: "online" } }),
    });

    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.queryByTestId("display-ended-notice")).toBeNull();
  });
});

describe("the German catalog carries the same promise", () => {
  beforeAll(async () => {
    await useLanguage("de");
  });

  afterEach(async () => {
    Reflect.deleteProperty(navigator, "mediaDevices");
    await useLanguage("en");
  });

  it("states the sound-only promise in German too", async () => {
    setDisplayCapture(true);
    window.localStorage.removeItem(MODE_KEY);
    const user = userEvent.setup();
    renderWithProviders(<RecordRoute />, { recording: stubRecordingSession({ start: startSpy }) });

    await user.click(screen.getByTestId("capture-mode-online"));

    await waitFor(() =>
      expect(screen.getByTestId("capture-mode-note")).toHaveTextContent(
        "Quorum nimmt ausschließlich den Ton",
      ),
    );
  });
});
