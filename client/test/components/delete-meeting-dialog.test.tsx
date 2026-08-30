import { beforeAll, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DeleteMeetingDialog } from "@/components/meetings/delete-meeting-dialog";
import { renderWithProviders, useLanguage } from "./render";

/**
 * Deleting a meeting runs the ADR-001 cascade: audio, transcripts and summaries, none of it
 * recoverable. The dialog's job is to be impossible to pass through by accident, and that is
 * behavior no logic test can check — it lives in focus, in roles, and in which control is wired
 * to which callback.
 */
describe("delete meeting confirmation", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  const MEETING = "Sprint review · March 4";

  function open(onConfirm = vi.fn(), onOpenChange = vi.fn()) {
    renderWithProviders(
      <DeleteMeetingDialog
        open
        onOpenChange={onOpenChange}
        meetingLabel={MEETING}
        onConfirm={onConfirm}
      />,
    );
    return { onConfirm, onOpenChange };
  }

  it("blocks the screen behind it", () => {
    open();
    // An alertdialog, not a dialog: the difference is whether assistive technology treats it as
    // an interruption that has to be answered. The cascade is not dismissible background noise.
    expect(screen.getByRole("alertdialog")).toBeInTheDocument();
  });

  it("names the meeting and everything the cascade destroys", () => {
    open();
    const body = screen.getByRole("alertdialog").textContent ?? "";
    expect(body).toContain(MEETING);
    // Naming the consequences is the point of the copy: a user who reads "delete this meeting?"
    // does not necessarily know the transcripts and summaries go with it.
    expect(body).toMatch(/audio recording/i);
    expect(body).toMatch(/transcripts/i);
    expect(body).toMatch(/summaries/i);
    expect(body).toMatch(/cannot be undone/i);
  });

  it("starts with the safe action focused", async () => {
    open();
    // A stray Return must cancel, never delete.
    await waitFor(() => expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus());
  });

  it("deletes only on the explicit destructive action", async () => {
    const user = userEvent.setup();
    const { onConfirm } = open();

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onConfirm).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete permanently" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape without deleting", async () => {
    const user = userEvent.setup();
    const { onConfirm, onOpenChange } = open();

    await user.keyboard("{Escape}");

    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("labels the destructive action with what it does, not with a bare yes", () => {
    open();
    // "OK" next to "Cancel" makes the user reconstruct which one deletes. The button says so.
    expect(screen.queryByRole("button", { name: /^(ok|yes)$/i })).toBeNull();
    expect(screen.getByRole("button", { name: "Delete permanently" })).toBeInTheDocument();
  });

  it("asks every time — there is no way to switch the question off", () => {
    open();
    // Deletion is real and irreversible, so a "don't ask again" would be a trap the user sets
    // for themselves. Its absence is a decision worth pinning down.
    expect(screen.queryByRole("checkbox")).toBeNull();
  });
});
