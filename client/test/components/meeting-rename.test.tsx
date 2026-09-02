import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MeetingTitleField } from "@/components/meetings/meeting-title-field";
import { renderWithProviders, useLanguage } from "./render";

/**
 * Renaming a meeting from the screen that shows it.
 *
 * The feature exists for a machine-written name: a recording nobody titled is titled by its
 * summary, and the user has to be able to correct that. So what is held here is what a user can
 * perceive — the heading, the editor, what reaches the server, and what happens to their typing
 * when the save fails.
 */
describe("renaming a meeting", () => {
  const onRename = vi.fn();

  beforeAll(async () => {
    await useLanguage("en");
  });

  beforeEach(() => {
    onRename.mockReset();
    onRename.mockResolvedValue(undefined);
  });

  function renderField(title: string | null) {
    return renderWithProviders(
      <MeetingTitleField title={title} placeholder="Untitled meeting" onRename={onRename} />,
    );
  }

  it("shows the name as a heading until the user asks to change it", async () => {
    renderField("Named by the summary");

    expect(screen.getByRole("heading", { name: "Named by the summary" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Rename meeting" }));
    expect(screen.getByRole("textbox", { name: "Meeting title" })).toHaveValue(
      "Named by the summary",
    );
  });

  it("shows the placeholder for a meeting that has no name at all", () => {
    renderField(null);
    expect(screen.getByRole("heading", { name: "Untitled meeting" })).toBeInTheDocument();
  });

  it("saves what was typed when Enter is pressed", async () => {
    renderField("Named by the summary");
    await userEvent.click(screen.getByRole("button", { name: "Rename meeting" }));

    const field = screen.getByRole("textbox", { name: "Meeting title" });
    await userEvent.clear(field);
    await userEvent.type(field, "Quarterly planning{Enter}");

    expect(onRename).toHaveBeenCalledWith("Quarterly planning");
  });

  it("sends an empty title, which is how a user takes a wrong name back off", async () => {
    renderField("Named by the summary");
    await userEvent.click(screen.getByRole("button", { name: "Rename meeting" }));
    await userEvent.clear(screen.getByRole("textbox", { name: "Meeting title" }));
    await userEvent.click(screen.getByRole("button", { name: "Save name" }));

    expect(onRename).toHaveBeenCalledWith("");
  });

  it("restores the old name on Escape without asking the server for anything", async () => {
    renderField("Named by the summary");
    await userEvent.click(screen.getByRole("button", { name: "Rename meeting" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Meeting title" }), " and more");
    await userEvent.keyboard("{Escape}");

    expect(onRename).not.toHaveBeenCalled();
    expect(screen.getByRole("heading", { name: "Named by the summary" })).toBeInTheDocument();
  });

  it("says nothing to the server when the name was not actually changed", async () => {
    renderField("Named by the summary");
    await userEvent.click(screen.getByRole("button", { name: "Rename meeting" }));
    await userEvent.click(screen.getByRole("button", { name: "Save name" }));

    expect(onRename).not.toHaveBeenCalled();
  });

  it("keeps the typed name on screen when the save fails, and says so", async () => {
    onRename.mockRejectedValue(new Error("network"));
    renderField(null);

    await userEvent.click(screen.getByRole("button", { name: "Rename meeting" }));
    await userEvent.type(screen.getByRole("textbox", { name: "Meeting title" }), "Quarterly");
    await userEvent.click(screen.getByRole("button", { name: "Save name" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("could not be saved");
    expect(screen.getByRole("textbox", { name: "Meeting title" })).toHaveValue("Quarterly");
  });

  it("is available in German, from the catalog rather than from the code", async () => {
    await useLanguage("de");
    renderField("Vom Protokoll benannt");

    expect(screen.getByRole("button", { name: "Meeting umbenennen" })).toBeInTheDocument();
    await useLanguage("en");
  });
});
