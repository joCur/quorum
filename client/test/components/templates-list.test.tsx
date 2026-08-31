import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SUMMARY_SCHEMA_VERSION, type SummaryTemplateView } from "@quorum/shared";
import type { TemplatesState } from "@/features/templates/use-templates";
import { renderWithProviders, useLanguage } from "./render";

/**
 * The templates screen as a card grid: what a card says about a template, and what its labeled
 * pills do. The data hook is replaced because none of that depends on the server — what is under
 * test is the reading of a template and the wiring of its three actions.
 */
const templatesState = vi.hoisted(() => ({ current: null as TemplatesState | null }));

vi.mock("@/features/templates/use-templates", () => ({
  useTemplates: () => templatesState.current,
}));

const { TemplatesRoute } = await import("@/routes/templates");
const { TemplateEditor } = await import("@/components/templates/template-editor");

const SYSTEM_ID = "11111111-1111-4111-8111-111111111111";
const MINE_ID = "22222222-2222-4222-8222-222222222222";
const MINE = "Customer call";

function view(
  id: string,
  name: string,
  sections: readonly string[],
  options: { editable: boolean; isDefault: boolean },
): SummaryTemplateView {
  return {
    template: {
      id,
      schemaVersion: SUMMARY_SCHEMA_VERSION,
      name,
      version: 1,
      scope: options.editable ? "user" : "system",
      basedOn: null,
      sections: [],
      overrides: [],
      options: { tone: "neutral", length: "standard", outputLanguage: "auto" },
    },
    resolvedSections: sections.map((title, index) => ({
      id: `s${index}`,
      title,
      instruction: "",
      format: "bullets" as const,
    })),
    editable: options.editable,
    isDefault: options.isDefault,
  };
}

const chooseDefault = vi.fn();
const remove = vi.fn();

function setTemplates(templates: SummaryTemplateView[]): void {
  templatesState.current = {
    templates,
    status: "ready",
    errorCode: null,
    saving: false,
    reload: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove,
    chooseDefault,
  } as unknown as TemplatesState;
}

function mineAndSystem(isDefault = false): SummaryTemplateView[] {
  return [
    view(SYSTEM_ID, "Standard meeting summary", ["Decisions"], {
      editable: false,
      isDefault: !isDefault,
    }),
    view(MINE_ID, MINE, ["Context", "Decisions", "Next steps"], {
      editable: true,
      isDefault,
    }),
  ];
}

function card(name: string): HTMLElement {
  const found = screen
    .getAllByTestId("template-card")
    .find((element) => element.textContent?.includes(name));
  if (!found) throw new Error(`no card for ${name}`);
  return found;
}

describe("templates card grid", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  beforeEach(() => {
    chooseDefault.mockClear();
    remove.mockClear();
  });

  it("previews the sections in the order the summary will carry them", () => {
    setTemplates(mineAndSystem());
    renderWithProviders(<TemplatesRoute />);

    // An ordered list, not a chip row: the order is part of what a template is, and the numbering
    // is the only thing that says so.
    const list = within(card(MINE)).getByRole("list", { name: "3 sections" });
    expect(list.tagName).toBe("OL");
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["Context", "Decisions", "Next steps"]);
  });

  it("labels its actions and reaches each one by the word on the pill", async () => {
    const user = userEvent.setup();
    setTemplates(mineAndSystem());
    renderWithProviders(<TemplatesRoute />);

    const mine = within(card(MINE));
    // Every accessible name starts with the visible label, so speech input can name a control by
    // what it reads (WCAG 2.5.3).
    const toggle = mine.getByRole("button", { name: `Default — use ${MINE} for new recordings` });
    expect(toggle).toHaveTextContent("Default");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(mine.getByRole("button", { name: `Edit ${MINE}` })).toHaveTextContent("Edit");

    await user.click(toggle);
    expect(chooseDefault).toHaveBeenCalledWith(MINE_ID);
  });

  it("hands the mark back to the system template rather than leaving none", async () => {
    const user = userEvent.setup();
    setTemplates(mineAndSystem(true));
    renderWithProviders(<TemplatesRoute />);

    const mine = within(card(MINE));
    expect(mine.getByTestId("template-default-badge")).toHaveTextContent("Default");

    await user.click(
      mine.getByRole("button", { name: `Default — stop using ${MINE} for new recordings` }),
    );
    // Null, not "no default": the system template takes the mark back.
    expect(chooseDefault).toHaveBeenCalledWith(null);
  });

  it("offers no actions on the template that is everybody's", () => {
    setTemplates(mineAndSystem());
    renderWithProviders(<TemplatesRoute />);

    const system = within(card("Standard meeting summary"));
    expect(system.getByText("System")).toBeInTheDocument();
    expect(system.queryAllByRole("button")).toHaveLength(0);
  });

  it("asks before deleting, and deletes only on the answer", async () => {
    const user = userEvent.setup();
    setTemplates(mineAndSystem());
    renderWithProviders(<TemplatesRoute />);

    await user.click(within(card(MINE)).getByRole("button", { name: `Delete ${MINE}` }));

    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent(MINE);
    expect(remove).not.toHaveBeenCalled();

    await user.click(within(dialog).getByRole("button", { name: "Delete template" }));
    expect(remove).toHaveBeenCalledWith(MINE_ID);
  });
});

function renderEditor(): void {
  const sections = ["Context", "Decisions"].map((title, index) => ({
    id: `s${index}`,
    title,
    instruction: "",
    format: "bullets" as const,
  }));

  renderWithProviders(
    <TemplateEditor
      initialName="Customer call"
      initialSections={sections}
      initialOptions={{ tone: "neutral", length: "standard", outputLanguage: "auto" }}
      baseSections={sections}
      basedOn={SYSTEM_ID}
      saving={false}
      onCancel={vi.fn()}
      onSave={vi.fn()}
    />,
  );
}

describe("template editor sections", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  it("numbers the section cards in the order they will be summarized", async () => {
    const user = userEvent.setup();
    renderEditor();

    const numbers = () => screen.getAllByTestId("section-number").map((el) => el.textContent);
    expect(numbers()).toEqual(["01", "02"]);

    // The number is a position, not an identity: moving a section renumbers rather than
    // travelling with it.
    await user.click(screen.getByRole("button", { name: "Move Decisions up" }));
    expect(numbers()).toEqual(["01", "02"]);
    expect(
      screen.getAllByLabelText("Heading").map((input) => (input as HTMLInputElement).value),
    ).toEqual(["Decisions", "Context"]);
  });

  it("keeps the fields named once the per-section help text is gone", async () => {
    const user = userEvent.setup();
    renderEditor();

    // The heading and the instruction lost their visible labels to the compact row; their
    // accessible names have to carry them, or the form stops being usable without sight.
    const instruction = screen.getAllByLabelText("What belongs in it")[0]!;
    await user.clear(screen.getAllByLabelText("Heading")[0]!);
    await user.type(screen.getAllByLabelText("Heading")[0]!, "Risks");
    await user.type(instruction, "Named risks only.");

    expect((instruction as HTMLTextAreaElement).value).toBe("Named risks only.");
    // The preview follows the form as it is edited, before anything is saved.
    expect(screen.getByRole("region", { name: "Preview" })).toHaveTextContent("Risks");
  });
});
