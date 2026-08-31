import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { RecordingSessionProvider } from "@/features/recording/recording-context";
import type { RecordingState } from "@/features/recording/use-recording";
import { renderWithProviders, stubRecordingSession, useLanguage } from "./render";

/**
 * The consent notice used to be a blocking dialog. It is a card on the start stage now, and the
 * start button carries the affirmation — one action instead of three.
 *
 * What these tests protect is the legal requirement, not the visual change: the notice is present
 * before every recording, it cannot be dismissed, and no code path reaches `start` without it
 * having been on screen with the user pressing a control that says what they are confirming.
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

const START_BUTTON = "I have informed the participants — start recording";

/**
 * The route with a session whose phase the test drives, so a single mounted screen can be walked
 * through a sequence of phases the way a real recording walks through them. Re-rendering the route
 * with a different session prop would not do: what is under test is what one continuous visit
 * shows, and remounting would throw that history away.
 */
function Session({ phase }: { phase: RecordingState["phase"] }) {
  return (
    <RecordingSessionProvider
      value={stubRecordingSession({ state: { phase, elapsedSeconds: 75 } })}
    >
      <RecordRoute />
    </RecordingSessionProvider>
  );
}
const NOTICE_BODY = /You are responsible for informing all participants/;

describe("the consent card on the start stage", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the notice on the stage itself, with no dialog in the way", () => {
    renderWithProviders(<RecordRoute />, { recording: stubRecordingSession() });

    const card = screen.getByTestId("consent-card");
    expect(within(card).getByText("Before you record")).toBeInTheDocument();
    expect(within(card).getByText(NOTICE_BODY)).toBeInTheDocument();
    // The point of the change: the notice no longer interrupts. Nothing on this screen is modal,
    // and the title field next to it is reachable without answering anything first.
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Meeting title")).toBeEnabled();
  });

  it("is a labelled region that precedes the button acting on it", () => {
    renderWithProviders(<RecordRoute />, { recording: stubRecordingSession() });

    // A screen reader must reach the obligation before the control, which is a fact about
    // document order rather than about layout.
    const card = screen.getByTestId("consent-card");
    expect(card).toHaveAccessibleName("Before you record");
    const button = screen.getByRole("button", { name: START_BUTTON });
    expect(card.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("cannot be dismissed — there is no control that removes it", async () => {
    const user = userEvent.setup();
    renderWithProviders(<RecordRoute />, { recording: stubRecordingSession() });

    const card = screen.getByTestId("consent-card");
    expect(within(card).queryByRole("button")).not.toBeInTheDocument();
    // Escape closed the old dialog. There is nothing here for it to close, and the notice stays.
    await user.keyboard("{Escape}");
    expect(screen.getByTestId("consent-card")).toBeInTheDocument();
  });

  it("starts the recording from the one button that states what it confirms", async () => {
    const user = userEvent.setup();
    const start = vi.fn();
    renderWithProviders(<RecordRoute />, { recording: stubRecordingSession({ start }) });

    await user.type(screen.getByLabelText("Meeting title"), "Weekly sync");
    await user.click(screen.getByRole("button", { name: START_BUTTON }));

    expect(start).toHaveBeenCalledWith("Weekly sync", null, null);
  });

  it("keeps the notice on screen for the next recording", () => {
    // No "don't show again", and no state that could remember an earlier acknowledgement: a
    // session that has just finished still opens on a stage carrying the notice.
    renderWithProviders(<RecordRoute />, {
      recording: stubRecordingSession({ state: { phase: "idle" } }),
    });

    expect(screen.getByTestId("consent-card")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: START_BUTTON })).toBeInTheDocument();
  });

  it("never reappears between the stop and the navigation away", () => {
    // The regression this pins: `finalized` is terminal, not resting. The screen used to fall
    // back to the start stage the moment the server confirmed, so a finished recording flashed
    // the consent card and an empty title field for the length of the settle delay before
    // navigating — a recording that had just ended appearing to offer a new one.
    const { rerender } = renderWithProviders(<Session phase="recording" />, {
      recording: stubRecordingSession(),
    });
    expect(screen.queryByTestId("consent-card")).not.toBeInTheDocument();

    // Stop → the server confirms → the route navigates a beat later. Every step in between has to
    // hold the closing view.
    for (const phase of ["finalizing", "finalized"] as const) {
      rerender(<Session phase={phase} />);
      expect(screen.queryByTestId("consent-card")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Meeting title")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: START_BUTTON })).not.toBeInTheDocument();
      // The final time stays on screen instead of the stage being torn down under the user.
      expect(screen.getByTestId("recording-timer")).toHaveTextContent("01:15");
    }
  });

  it("still opens on the start stage when the last session finished in an earlier visit", () => {
    // The mirror case, and the reason the closing view cannot be keyed on the phase alone: the
    // session outlives the screen, so arriving on a leftover finished one must show the stage
    // rather than another recording's closing view.
    renderWithProviders(<RecordRoute />, {
      recording: stubRecordingSession({
        state: { phase: "finalized", elapsedSeconds: 75, meetingId: "m" },
      }),
    });

    expect(screen.getByTestId("consent-card")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: START_BUTTON })).toBeInTheDocument();
  });

  it("is gone once capture is running — it belongs to starting, not to recording", () => {
    renderWithProviders(<RecordRoute />, {
      recording: stubRecordingSession({ state: { phase: "recording" } }),
    });

    expect(screen.queryByTestId("consent-card")).not.toBeInTheDocument();
  });
});
