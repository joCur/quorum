import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Meeting, MeetingStatus } from "@quorum/shared";
import { MeetingList } from "@/components/meetings/meeting-list";
import type { MeetingsList } from "@/features/meetings/use-meetings";
import { renderWithProviders, useLanguage } from "./render";

/**
 * The meetings list is the app's front door, and the day grouping is the only thing that tells
 * the user *when* — the rows themselves no longer carry a date. A wrong bucket is invisible to
 * every other test: everything renders, nothing throws, and the meeting is simply filed under
 * the wrong day.
 */

const NOW = new Date(2026, 7, 31, 14, 30); // A Monday afternoon.

function meeting(overrides: Partial<Meeting> = {}): Meeting {
  return {
    id: "11111111-0000-4000-8000-000000000001",
    sessionId: "11111111-0000-4000-8000-000000000002",
    title: "Weekly sync",
    status: "ready",
    audioFormat: { codec: "opus", container: "webm", sampleRate: 48_000, channels: 1 },
    createdAt: new Date(2026, 7, 31, 10, 0).toISOString(),
    finalizedAt: null,
    durationSeconds: 3725,
    language: "en",
    progress: null,
    hasAudio: true,
    failure: null,
    ...overrides,
  };
}

function list(overrides: Partial<MeetingsList> = {}): MeetingsList {
  return {
    meetings: [],
    status: "ready",
    errorCode: null,
    deleting: new Set<string>(),
    reload: () => undefined,
    remove: async () => undefined,
    ...overrides,
  };
}

function renderList(value: MeetingsList) {
  return renderWithProviders(
    <MeetingList
      list={value}
      searching={false}
      onClearSearch={() => undefined}
      onboarding={<p>onboarding</p>}
    />,
  );
}

describe("meetings list", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gathers the rows under their heading, in order", () => {
    renderList(
      list({
        meetings: [
          meeting({ id: "a", title: "Today sync", createdAt: NOW.toISOString() }),
          meeting({
            id: "b",
            title: "Yesterday sync",
            createdAt: new Date(2026, 7, 30, 9, 0).toISOString(),
          }),
          meeting({
            id: "c",
            title: "Midweek sync",
            createdAt: new Date(2026, 7, 27, 9, 0).toISOString(),
          }),
        ],
      }),
    );

    const headings = screen.getAllByRole("heading", { level: 2 }).map((node) => node.textContent);
    expect(headings).toEqual(["Today", "Yesterday", "This week"]);
    expect(
      within(screen.getByRole("heading", { name: "Yesterday" }).closest("section")!).getByText(
        "Yesterday sync",
      ),
    ).toBeInTheDocument();
  });

  it("labels an older week by the range of days it covers", () => {
    // Past the rolling window the heading stops being a word and becomes the dates themselves,
    // which is what makes a Monday-to-Sunday week readable without knowing the convention.
    renderList(
      list({
        meetings: [
          meeting({
            id: "w",
            title: "Two weeks ago",
            createdAt: new Date(2026, 7, 18, 10, 0).toISOString(),
          }),
        ],
      }),
    );
    expect(screen.getByRole("heading", { name: /^Aug 17\s*–\s*23$/ })).toBeInTheDocument();
    // A row under a week heading still says only its weekday and time.
    expect(screen.getByText(/^Tue · /)).toBeInTheDocument();
  });

  it("degrades to a month heading past the week horizon, and dates the rows under it", () => {
    renderList(
      list({
        meetings: [
          meeting({
            id: "o",
            title: "Spring review",
            createdAt: new Date(2026, 2, 17, 10, 0).toISOString(),
          }),
        ],
      }),
    );
    expect(screen.getByRole("heading", { name: "March 2026" })).toBeInTheDocument();
    // A month leaves the day open, so the row names its date rather than a weekday.
    expect(screen.getByText(/Mar 17/)).toBeInTheDocument();
  });

  it("orders week and month headings under the named ones, newest first", () => {
    renderList(
      list({
        meetings: [
          meeting({ id: "old", createdAt: new Date(2026, 2, 17).toISOString() }),
          meeting({ id: "now", createdAt: NOW.toISOString() }),
          meeting({ id: "week", createdAt: new Date(2026, 7, 18).toISOString() }),
        ],
      }),
    );
    expect(
      screen
        .getAllByRole("heading", { level: 2 })
        // `Intl` sets the range with thin spaces around the dash; the words are the assertion.
        .map((node) => node.textContent?.replace(/\s+/gu, " ")),
    ).toEqual(["Today", "Aug 17 – 23", "March 2026"]);
  });

  it("gives every row a right-aligned mono duration column", () => {
    // The column is the reason the titles line up; an intrinsic width would undo it.
    const { container } = renderList(list({ meetings: [meeting()] }));
    const duration = screen.getByText("1:02:05");
    expect(duration.className).toContain("font-mono");
    expect(duration.className).toContain("text-right");
    expect(duration.className).toContain("w-[74px]");
    expect(container.querySelectorAll("li")).toHaveLength(1);
  });

  it("says nothing about a meeting that is simply finished", () => {
    // The resting state is silent: a "Ready" chip on every row is a label repeated until it
    // stops being read.
    renderList(list({ meetings: [meeting({ status: "ready" })] }));
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
    expect(screen.getByText("Weekly sync")).toBeInTheDocument();
  });

  const NOISY: readonly { status: MeetingStatus; label: string }[] = [
    { status: "queued", label: "Queued" },
    { status: "transcribing", label: "Transcribing" },
    { status: "summarizing", label: "Summarizing" },
    { status: "failed", label: "Failed" },
  ];

  it.each(NOISY)("still reports the $status state", ({ status, label }) => {
    renderList(list({ meetings: [meeting({ status })] }));
    expect(screen.getByText(label)).toBeInTheDocument();
  });

  it("pops a Done chip when a meeting finishes under the user's eyes, then drops it", () => {
    const processing = meeting({ status: "transcribing" });
    const { rerender } = renderWithProviders(
      <MeetingList
        list={list({ meetings: [processing] })}
        searching={false}
        onClearSearch={() => undefined}
        onboarding={null}
      />,
    );
    expect(screen.queryByText("Done")).not.toBeInTheDocument();

    act(() => {
      rerender(
        <MeetingList
          list={list({ meetings: [{ ...processing, status: "ready" }] })}
          searching={false}
          onClearSearch={() => undefined}
          onboarding={null}
        />,
      );
    });
    expect(screen.getByText("Done")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.queryByText("Done")).not.toBeInTheDocument();
  });

  it("does not pop for meetings that were already finished on arrival", () => {
    // Nothing happened — the user simply looked at the list.
    renderList(list({ meetings: [meeting({ status: "ready" })] }));
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.queryByText("Done")).not.toBeInTheDocument();
  });

  it("keeps the two-step delete flow on every row", async () => {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const remove = vi.fn(async () => undefined);
    renderList(list({ meetings: [meeting()], remove }));

    await user.click(screen.getByRole("button", { name: "Delete Weekly sync" }));
    expect(screen.getByText("Delete this meeting?")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Delete permanently" }));
    expect(remove).toHaveBeenCalledWith("11111111-0000-4000-8000-000000000001");
  });

  it("translates the named headings and reformats the dated ones", async () => {
    // The named buckets go through i18n; the dated ones go through `Intl`, which reorders the
    // range rather than translating the English shape of it.
    await useLanguage("de");
    renderList(
      list({
        meetings: [
          meeting({ id: "n", createdAt: NOW.toISOString() }),
          meeting({ id: "w", createdAt: new Date(2026, 7, 18, 10, 0).toISOString() }),
          meeting({ id: "m", createdAt: new Date(2026, 2, 17, 10, 0).toISOString() }),
        ],
      }),
    );
    expect(screen.getByRole("heading", { name: "Heute" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^17\.\s*–\s*23\.\s*Aug\.$/ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "März 2026" })).toBeInTheDocument();
    await useLanguage("en");
  });
});
