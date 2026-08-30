import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Meeting } from "@quorum/shared";
import { MeetingList } from "@/components/meetings/meeting-list";
import { Toaster } from "@/components/ui/toaster";
import type { MeetingsList } from "@/features/meetings/use-meetings";
import { renderWithProviders, useLanguage } from "./render";

vi.mock("@/features/theme/theme-provider", () => ({
  // The toast host asks the theme provider which scheme is on screen; the answer is not what
  // this test is about, and mocking it keeps the provider stack to the ones that matter.
  useTheme: () => ({ preference: "light", setPreference: vi.fn(), resolved: "light" }),
}));

function meeting(): Meeting {
  return {
    id: "2f9c0f21-1b2a-4f6d-9f8e-0a1b2c3d4e5f",
    sessionId: "11111111-2222-4333-8444-555555555555",
    title: "Sprint review",
    status: "ready",
    audioFormat: { codec: "opus", container: "webm", sampleRate: 48_000, channels: 1 },
    createdAt: "2026-03-04T09:00:00.000Z",
    finalizedAt: "2026-03-04T10:00:00.000Z",
    durationSeconds: 3_600,
    language: "en",
    progress: null,
    hasAudio: true,
    failure: null,
  };
}

/**
 * The confirmation after a deletion has actually gone through.
 *
 * Deletion is a server-side cascade, so the row is held in place until the server confirms and
 * the outcome lands well after the dialog has closed. The row quietly vanishing reads the same as
 * a row scrolling away — the toast is what turns it into an answer.
 */
describe("post-delete confirmation", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  // Sonner keeps its queue in a module-level store, which outlives the unmounted host. Without
  // this, a toast raised by one test is still queued when the next one mounts a Toaster.
  afterEach(() => {
    toast.dismiss();
  });

  function renderList(remove: MeetingsList["remove"]) {
    const list: MeetingsList = {
      meetings: [meeting()],
      status: "ready",
      errorCode: null,
      deleting: new Set<string>(),
      reload: vi.fn(),
      remove,
    };

    return renderWithProviders(
      <>
        <MeetingList
          list={list}
          searching={false}
          onClearSearch={vi.fn()}
          onboarding={<p>onboarding</p>}
        />
        <Toaster />
      </>,
    );
  }

  async function confirmDelete(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole("button", { name: /Delete Sprint review/ }));
    await user.click(screen.getByRole("button", { name: "Delete permanently" }));
  }

  it("names the meeting that is gone once the server has confirmed", async () => {
    const user = userEvent.setup();
    renderList(vi.fn().mockResolvedValue(undefined));

    await confirmDelete(user);

    await waitFor(() =>
      expect(screen.getByText(/^“Sprint review.*” was deleted\.$/)).toBeInTheDocument(),
    );
  });

  it("says nothing until the deletion has actually happened", async () => {
    const user = userEvent.setup();
    // A deletion the server never answers: the cascade is still running, so there is nothing to
    // confirm yet. Announcing it here would be the optimistic vanish the list deliberately avoids.
    renderList(vi.fn().mockReturnValue(new Promise<void>(() => {})));

    await confirmDelete(user);

    expect(screen.queryByText(/was deleted/)).toBeNull();
  });

  it("says so when the deletion failed instead of leaving it ambiguous", async () => {
    const user = userEvent.setup();
    renderList(vi.fn().mockRejectedValue(new Error("nope")));

    await confirmDelete(user);

    // The row is still there either way, so silence would read as "nothing happened" — which is
    // true, but not something the user can act on.
    await waitFor(() =>
      expect(screen.getByText(/^“Sprint review.*” could not be deleted\.$/)).toBeInTheDocument(),
    );
  });

  it("confirms nothing when the user backs out", async () => {
    const user = userEvent.setup();
    const remove = vi.fn().mockResolvedValue(undefined);
    renderList(remove);

    await user.click(screen.getByRole("button", { name: /Delete Sprint review/ }));
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    expect(remove).not.toHaveBeenCalled();
    expect(screen.queryByText(/was deleted/)).toBeNull();
  });
});
