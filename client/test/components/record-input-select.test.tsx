import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithProviders, useLanguage } from "./render";

/**
 * The microphone picker on the recording start screen.
 *
 * Recording itself is mocked away — this is about what the screen offers before capture begins,
 * which is decided entirely by what `enumerateDevices` reports and what was remembered from last
 * time. Both are held here.
 */
const startSpy = vi.hoisted(() => vi.fn());

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

vi.mock("@/features/recording/use-recording", () => ({
  useRecording: () => ({
    state: {
      phase: "idle",
      status: null,
      error: null,
      level: 0,
      silent: false,
      elapsedSeconds: 0,
      storageLow: false,
      inputFallback: false,
      wakeLockSupported: true,
    },
    start: startSpy,
    pause: vi.fn(),
    resume: vi.fn(),
    stop: vi.fn(),
  }),
}));

const { RecordRoute } = await import("@/routes/record");

const STORAGE_KEY = "quorum.recording.input-device";
const MIC_LABEL = "Microphone";
const HEADSET = "headset-1";
const BUILT_IN = "built-in-1";

function device(deviceId: string, label: string, kind: MediaDeviceKind = "audioinput") {
  return { deviceId, label, kind, groupId: "group" } as MediaDeviceInfo;
}

function setDevices(devices: MediaDeviceInfo[]): void {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: vi.fn(async () => devices),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
  });
}

describe("record screen microphone choice", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  beforeEach(() => {
    startSpy.mockClear();
    window.localStorage.removeItem(STORAGE_KEY);
  });

  afterEach(() => {
    Reflect.deleteProperty(navigator, "mediaDevices");
  });

  it("stays silent when there is only one microphone", async () => {
    setDevices([device(BUILT_IN, "Built-in Microphone")]);
    renderWithProviders(<RecordRoute />);

    // The resting state offers no control that cannot change anything.
    await waitFor(() => expect(screen.getByLabelText("Meeting title")).toBeInTheDocument());
    expect(screen.queryByLabelText(MIC_LABEL)).toBeNull();
  });

  it("stays silent while the devices are still unnamed", async () => {
    // Before the microphone permission is granted every browser returns empty labels. Offering
    // "Microphone 1 / Microphone 2" would be a choice the user cannot make.
    setDevices([device(HEADSET, ""), device(BUILT_IN, "")]);
    renderWithProviders(<RecordRoute />);

    await waitFor(() => expect(screen.getByLabelText("Meeting title")).toBeInTheDocument());
    expect(screen.queryByLabelText(MIC_LABEL)).toBeNull();
  });

  it("offers the named inputs plus the system default", async () => {
    setDevices([device(HEADSET, "Headset"), device(BUILT_IN, "Built-in Microphone")]);
    renderWithProviders(<RecordRoute />);

    const select = await screen.findByLabelText<HTMLSelectElement>(MIC_LABEL);
    expect(select.value).toBe("");
    expect(screen.getByRole("option", { name: "System default" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Headset" })).toBeInTheDocument();
  });

  it("preselects the microphone that was used last", async () => {
    window.localStorage.setItem(STORAGE_KEY, HEADSET);
    setDevices([device(HEADSET, "Headset"), device(BUILT_IN, "Built-in Microphone")]);
    renderWithProviders(<RecordRoute />);

    expect(await screen.findByLabelText<HTMLSelectElement>(MIC_LABEL)).toHaveValue(HEADSET);
  });

  it("falls back to the default when the remembered microphone is gone, and says so once", async () => {
    const user = userEvent.setup();
    window.localStorage.setItem(STORAGE_KEY, "gone-forever");
    setDevices([device(HEADSET, "Headset"), device(BUILT_IN, "Built-in Microphone")]);
    renderWithProviders(<RecordRoute />);

    const select = await screen.findByLabelText<HTMLSelectElement>(MIC_LABEL);
    expect(select.value).toBe("");
    expect(
      await screen.findByText(
        "The microphone you used last is not connected. This recording uses the system default.",
      ),
    ).toBeInTheDocument();
    // Forgotten for good: the stale id does not come back to haunt the next recording.
    expect(window.localStorage.getItem(STORAGE_KEY)).toBeNull();

    await user.selectOptions(select, HEADSET);

    // Once the user has answered it, the notice has nothing left to say.
    expect(
      screen.queryByText(
        "The microphone you used last is not connected. This recording uses the system default.",
      ),
    ).toBeNull();
  });

  it("records with the chosen microphone and remembers it", async () => {
    const user = userEvent.setup();
    setDevices([device(HEADSET, "Headset"), device(BUILT_IN, "Built-in Microphone")]);
    renderWithProviders(<RecordRoute />);

    const select = await screen.findByLabelText<HTMLSelectElement>(MIC_LABEL);
    await user.selectOptions(select, HEADSET);
    await user.click(screen.getByRole("button", { name: "Record" }));
    await user.click(screen.getByRole("button", { name: "I have informed the participants" }));

    expect(startSpy).toHaveBeenCalledWith(null, null, HEADSET);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe(HEADSET);
  });

  it("records on the default when nothing was chosen", async () => {
    const user = userEvent.setup();
    setDevices([device(HEADSET, "Headset"), device(BUILT_IN, "Built-in Microphone")]);
    renderWithProviders(<RecordRoute />);

    await screen.findByLabelText(MIC_LABEL);
    await user.click(screen.getByRole("button", { name: "Record" }));
    await user.click(screen.getByRole("button", { name: "I have informed the participants" }));

    // No id travels rather than one guessed from the list: the system default is the browser's
    // to decide, and it can change between recordings.
    expect(startSpy).toHaveBeenCalledWith(null, null, null);
  });
});
