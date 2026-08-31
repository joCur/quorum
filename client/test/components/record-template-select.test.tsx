import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SUMMARY_SCHEMA_VERSION, type SummaryTemplateView } from "@quorum/shared";
import type { TemplatesState } from "@/features/templates/use-templates";
import { renderWithProviders, stubRecordingSession, useLanguage } from "./render";

/**
 * The recording screen is driven by the microphone and a live WebSocket, neither of which exists
 * here and neither of which this test is about. Both hooks are replaced so the test can hold the
 * two states that matter: what templates the user has, and what the screen offers as a result.
 */
const templatesState = vi.hoisted(() => ({ current: null as TemplatesState | null }));
const startSpy = vi.hoisted(() => vi.fn());

vi.mock("@/features/templates/use-templates", () => ({
  useTemplates: () => templatesState.current,
}));

const { RecordRoute } = await import("@/routes/record");

const SYSTEM = "11111111-1111-4111-8111-111111111111";
const MINE = "22222222-2222-4222-8222-222222222222";

const TEMPLATE_LABEL = "Summary template";
const TITLE_LABEL = "Meeting title";

function view(id: string, name: string, isDefault: boolean): SummaryTemplateView {
  return {
    template: {
      id,
      schemaVersion: SUMMARY_SCHEMA_VERSION,
      name,
      version: 1,
      scope: "user",
      basedOn: null,
      sections: [],
      overrides: [],
      options: { tone: "neutral", length: "standard", outputLanguage: "auto" },
    },
    resolvedSections: [],
    editable: true,
    isDefault,
  };
}

function setTemplates(
  templates: SummaryTemplateView[],
  status: TemplatesState["status"] = "ready",
): void {
  templatesState.current = {
    templates,
    status,
    errorCode: null,
    saving: false,
    reload: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    chooseDefault: vi.fn(),
  } as unknown as TemplatesState;
}

describe("record screen template choice", () => {
  beforeAll(async () => {
    await useLanguage("en");
  });

  beforeEach(() => {
    startSpy.mockClear();
  });

  it("stays silent when there is nothing to choose between", () => {
    setTemplates([view(SYSTEM, "Standard summary", true)]);
    renderWithProviders(<RecordRoute />, { recording: stubRecordingSession({ start: startSpy }) });

    // One template is no choice. A select with a single option is a control that cannot do
    // anything, and the resting state says nothing rather than offering one.
    expect(screen.queryByLabelText(TEMPLATE_LABEL)).toBeNull();
    // The title field is unconditional, so its presence proves the form rendered at all — the
    // assertion above is about the select, not about an empty screen.
    expect(screen.getByLabelText(TITLE_LABEL)).toBeInTheDocument();
  });

  it("stays silent while the templates are still loading", () => {
    setTemplates([], "loading");
    renderWithProviders(<RecordRoute />, { recording: stubRecordingSession({ start: startSpy }) });

    // A control that appears a beat late is worse than one that never appears: the user is
    // already reaching for the record button.
    expect(screen.queryByLabelText(TEMPLATE_LABEL)).toBeNull();
  });

  it("offers the choice once the user has one of their own", () => {
    setTemplates([view(SYSTEM, "Standard summary", false), view(MINE, "Client call", true)]);
    renderWithProviders(<RecordRoute />, { recording: stubRecordingSession({ start: startSpy }) });

    expect(screen.getByLabelText(TEMPLATE_LABEL)).toBeInTheDocument();
  });

  it("prefills the user's default rather than the first template in the list", () => {
    // The default is not necessarily first, and picking by position is the bug this pins down.
    setTemplates([view(SYSTEM, "Standard summary", false), view(MINE, "Client call", true)]);
    renderWithProviders(<RecordRoute />, { recording: stubRecordingSession({ start: startSpy }) });

    expect(screen.getByLabelText<HTMLSelectElement>(TEMPLATE_LABEL).value).toBe(MINE);
  });

  it("falls back to the first template when no default is set", () => {
    setTemplates([view(SYSTEM, "Standard summary", false), view(MINE, "Client call", false)]);
    renderWithProviders(<RecordRoute />, { recording: stubRecordingSession({ start: startSpy }) });

    // A select must show something; the system template is the sensible something.
    expect(screen.getByLabelText<HTMLSelectElement>(TEMPLATE_LABEL).value).toBe(SYSTEM);
  });

  it("keeps an explicit choice, even against the default", async () => {
    const user = userEvent.setup();
    setTemplates([view(SYSTEM, "Standard summary", false), view(MINE, "Client call", true)]);
    renderWithProviders(<RecordRoute />, { recording: stubRecordingSession({ start: startSpy }) });

    const select = screen.getByLabelText<HTMLSelectElement>(TEMPLATE_LABEL);
    await user.selectOptions(select, SYSTEM);

    // Once touched, the field is the user's; a late-arriving default must not reclaim it.
    expect(select.value).toBe(SYSTEM);
  });

  it("sends the template that was on screen, prefilled default included", async () => {
    const user = userEvent.setup();
    setTemplates([view(SYSTEM, "Standard summary", false), view(MINE, "Client call", true)]);
    renderWithProviders(<RecordRoute />, { recording: stubRecordingSession({ start: startSpy }) });

    await user.type(screen.getByLabelText(TITLE_LABEL), "Weekly sync");
    await user.click(screen.getByRole("button", { name: "Record" }));
    await user.click(screen.getByRole("button", { name: "I have informed the participants" }));

    // The template travels as an explicit id rather than as "send nothing", the prefilled default
    // included: what the screen showed when the recording started is what the summary is made
    // with, even if the default changes afterwards.
    expect(startSpy).toHaveBeenCalledWith("Weekly sync", MINE, null);
  });

  it("sends no template when the user has none to choose from", async () => {
    const user = userEvent.setup();
    setTemplates([], "ready");
    renderWithProviders(<RecordRoute />, { recording: stubRecordingSession({ start: startSpy }) });

    await user.click(screen.getByRole("button", { name: "Record" }));
    await user.click(screen.getByRole("button", { name: "I have informed the participants" }));

    // Nothing was shown, so nothing is claimed; the server applies its own default.
    expect(startSpy).toHaveBeenCalledWith(null, null, null);
  });
});
