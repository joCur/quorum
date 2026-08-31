import { beforeAll, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/layout/app-shell";
import type { RecordingSession, RecordingState } from "@/features/recording/use-recording";
import { renderWithProviders, stubRecordingSession, useLanguage } from "./render";

/**
 * The recording used to belong to the recording screen, so leaving the screen ended it and left
 * half a meeting behind. It belongs to the app now, which puts two obligations on the UI: away
 * from the recording screen the running session must be impossible to miss and one tap from
 * being back, and back on the recording screen the controls must attach to what is running
 * rather than offer to start something new.
 *
 * Both are asserted against a supplied session rather than a real microphone: what is under test
 * is which screen shows what, for a session in a given phase.
 */

vi.mock("@/features/templates/use-templates", () => ({
  useTemplates: () => ({
    status: "ready",
    templates: [],
    error: null,
    saving: false,
    reload: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    chooseDefault: vi.fn(),
  }),
}));

const { RecordRoute } = await import("@/routes/record");

const MEETING_DETAIL = "/meetings/2f9c0f21-1b2a-4f6d-9f8e-0a1b2c3d4e5f";

function session(
  state: Partial<RecordingState>,
  overrides: Partial<Omit<RecordingSession, "state">> = {},
) {
  return stubRecordingSession({ state, ...overrides });
}

function renderShell(recording: RecordingSession | null, route = "/meetings") {
  return renderWithProviders(
    <Routes>
      <Route path="/record" element={<p>recording screen</p>} />
      <Route element={<AppShell />}>
        <Route path="/meetings" element={<p>meetings</p>} />
        <Route path="/meetings/:meetingId" element={<p>detail</p>} />
        <Route path="/settings" element={<p>settings</p>} />
      </Route>
    </Routes>,
    { route, recording },
  );
}

function pill() {
  return screen.queryByTestId("recording-bar");
}

/** The idle record action, which the live pill takes the place of. */
function recordAction() {
  return screen.queryByRole("button", { name: "Record" });
}

describe("the live pill in the top bar", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  it("stays away when nothing is being recorded", () => {
    renderShell(session({ phase: "idle" }));
    expect(pill()).not.toBeInTheDocument();
    expect(recordAction()).toBeInTheDocument();
  });

  it("stays away where there is no recording session at all", () => {
    // The sign-in screens live outside the recording scope; an ambient consumer must cope.
    renderShell(null);
    expect(pill()).not.toBeInTheDocument();
    expect(recordAction()).toBeInTheDocument();
  });

  it("shows the running recording, with the recorded time", () => {
    renderShell(session({ phase: "recording", elapsedSeconds: 75, level: 0.4 }));
    expect(pill()).toBeInTheDocument();
    expect(screen.getByText("REC", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("01:15")).toBeInTheDocument();
  });

  it("takes the record action's place rather than sitting beside it", () => {
    // One slot, one meaning. Offering to start a recording next to one that is already running
    // is the ambiguity the single top bar exists to remove.
    renderShell(session({ phase: "recording" }));
    expect(recordAction()).not.toBeInTheDocument();
  });

  it("says when the running recording is paused", () => {
    renderShell(session({ phase: "paused", elapsedSeconds: 75 }));
    expect(pill()).toBeInTheDocument();
    expect(screen.getByText("PAUSE", { exact: true })).toBeInTheDocument();
    expect(recordAction()).not.toBeInTheDocument();
  });

  it("announces the phase, and only the phase", () => {
    // The timer ticks every second; inside a live region it would turn the bar into a metronome.
    renderShell(session({ phase: "recording", elapsedSeconds: 75 }));
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("REC");
    expect(status).not.toHaveTextContent("01:15");
  });

  it("shows on the meeting detail, which has no shell exception any more", () => {
    // The detail used to lose its navigation; a live recording may never be the thing that goes
    // missing on exactly the screen a user browses to mid-meeting.
    renderShell(session({ phase: "recording" }), MEETING_DETAIL);
    expect(pill()).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Meetings" })).toBeInTheDocument();
  });

  it("stays away once the recording is being finalized", () => {
    // Finalizing is the recording screen's own business, and it navigates away by itself.
    renderShell(session({ phase: "finalizing" }));
    expect(pill()).not.toBeInTheDocument();
  });

  it("is the way back to the recording", async () => {
    renderShell(session({ phase: "recording" }));
    await userEvent.click(screen.getByRole("button", { name: /Return to recording/ }));
    expect(screen.getByText("recording screen")).toBeInTheDocument();
  });
});

describe("returning to the recording screen", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  it("attaches to the running session instead of offering a new one", () => {
    const stop = vi.fn();
    const start = vi.fn();
    renderWithProviders(<RecordRoute />, {
      route: "/record",
      recording: session({ phase: "recording", elapsedSeconds: 75, level: 0.4 }, { start, stop }),
    });

    // The live state of the session, not a fresh screen: the recorded time, the live indicator,
    // and the record control in its stop form.
    expect(screen.getByTestId("recording-timer")).toHaveTextContent("01:15");
    expect(screen.getByText("REC", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Stop" })).toHaveAttribute("aria-pressed", "true");
    // No title field: this recording has already started.
    expect(screen.queryByLabelText("Meeting title")).not.toBeInTheDocument();
    expect(start).not.toHaveBeenCalled();
  });

  it("keeps the paused state it was left in", () => {
    renderWithProviders(<RecordRoute />, {
      route: "/record",
      recording: session({ phase: "paused", elapsedSeconds: 75 }),
    });

    expect(screen.getByText("PAUSED", { exact: true })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Resume" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause" })).not.toBeInTheDocument();
  });

  it("clears a finished session so the next visit starts fresh", () => {
    const reset = vi.fn();
    renderWithProviders(<RecordRoute />, {
      route: "/record",
      recording: session({ phase: "finalized", meetingId: "x" }, { reset }),
    });
    expect(reset).toHaveBeenCalled();
  });

  it("leaves a running session alone when the screen is opened", () => {
    // `reset` is still called — it is the screen saying "show me the current state" — and the
    // session is the one that refuses to throw a live recording away.
    const reset = vi.fn();
    renderWithProviders(<RecordRoute />, {
      route: "/record",
      recording: session({ phase: "recording" }, { reset }),
    });
    expect(screen.getByText("REC", { exact: true })).toBeInTheDocument();
    expect(reset).toHaveBeenCalled();
  });
});
