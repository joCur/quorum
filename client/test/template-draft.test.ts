import { describe, expect, it } from "vitest";
import { resolveTemplateSections, SummaryTemplateSchema } from "@quorum/shared";
import type { SummaryTemplate, TemplateSection } from "@quorum/shared";
import { moveSection, newSectionId, toDraft, toOverrides } from "@/features/templates/draft";

function section(id: string, title = id): TemplateSection {
  return { id, title, instruction: `About ${id}.`, format: "bullets" };
}

const BASE_SECTIONS = [section("one"), section("two"), section("three")];

const BASE: SummaryTemplate = SummaryTemplateSchema.parse({
  id: "0b7a1f4d-2c3e-4a55-9f61-8d5c4a2b7e10",
  schemaVersion: 1,
  name: "Base",
  version: 1,
  scope: "system",
  basedOn: null,
  sections: BASE_SECTIONS,
  overrides: [],
  options: {},
});

/**
 * The property that matters: whatever the editor produces, resolving it against the base has to
 * give back exactly the list the user arranged. Asserting on the override shapes alone would let
 * a wrong-but-plausible encoding pass.
 */
function resolves(edited: readonly TemplateSection[]): TemplateSection[] {
  const draft = toDraft({
    name: "Mine",
    basedOn: BASE.id,
    baseSections: BASE_SECTIONS,
    sections: edited,
    options: { tone: "neutral", length: "standard", outputLanguage: "auto" },
  });
  const stored = SummaryTemplateSchema.parse({
    ...BASE,
    id: "7c3f0e21-1a55-4d0a-9f2b-6e8c1d4a9b33",
    scope: "user",
    sections: [],
    basedOn: BASE.id,
    overrides: draft.overrides,
  });
  return resolveTemplateSections(stored, BASE);
}

describe("editor list to overrides", () => {
  it("stores nothing at all for an untouched list, so the base keeps reaching through", () => {
    expect(toOverrides(BASE_SECTIONS, BASE_SECTIONS)).toEqual([]);
  });

  it("hides a removed section and leaves the rest alone", () => {
    const edited = [BASE_SECTIONS[0]!, BASE_SECTIONS[2]!];
    expect(toOverrides(BASE_SECTIONS, edited)).toEqual([
      { sectionId: "two", action: "hide", section: null },
    ]);
    expect(resolves(edited).map((s) => s.id)).toEqual(["one", "three"]);
  });

  it("replaces an edited section without touching the untouched ones", () => {
    const edited = [
      BASE_SECTIONS[0]!,
      { ...BASE_SECTIONS[1]!, title: "Second" },
      BASE_SECTIONS[2]!,
    ];
    expect(toOverrides(BASE_SECTIONS, edited)).toEqual([
      { sectionId: "two", action: "replace", section: edited[1] },
    ]);
    expect(resolves(edited)[1]!.title).toBe("Second");
  });

  it("adds a new section at the end", () => {
    const extra = section("risks", "Risks");
    const edited = [...BASE_SECTIONS, extra];
    expect(toOverrides(BASE_SECTIONS, edited)).toEqual([
      { sectionId: "risks", action: "add", section: extra },
    ]);
    expect(resolves(edited).map((s) => s.id)).toEqual(["one", "two", "three", "risks"]);
  });

  it("restates the whole list when the order changed, and the order survives", () => {
    const edited = [BASE_SECTIONS[2]!, BASE_SECTIONS[0]!, BASE_SECTIONS[1]!];
    expect(resolves(edited).map((s) => s.id)).toEqual(["three", "one", "two"]);
  });

  it("restates the whole list when a new section is not at the end", () => {
    const extra = section("risks", "Risks");
    const edited = [BASE_SECTIONS[0]!, extra, BASE_SECTIONS[1]!, BASE_SECTIONS[2]!];
    expect(resolves(edited).map((s) => s.id)).toEqual(["one", "risks", "two", "three"]);
  });

  it("survives a combination of removing, editing, adding and reordering", () => {
    const extra = section("risks", "Risks");
    const edited = [extra, { ...BASE_SECTIONS[2]!, instruction: "Only the binding ones." }];
    const resolved = resolves(edited);
    expect(resolved.map((s) => s.id)).toEqual(["risks", "three"]);
    expect(resolved[1]!.instruction).toBe("Only the binding ones.");
  });
});

describe("draft assembly", () => {
  it("stores sections directly when the template inherits from nothing", () => {
    const draft = toDraft({
      name: "  Standalone  ",
      basedOn: null,
      baseSections: [],
      sections: BASE_SECTIONS,
      options: { tone: "formal", length: "brief", outputLanguage: "de" },
    });
    expect(draft.name).toBe("Standalone");
    expect(draft.sections).toEqual(BASE_SECTIONS);
    expect(draft.overrides).toEqual([]);
    expect(draft.options.outputLanguage).toBe("de");
  });

  it("stores overrides and no sections when it inherits", () => {
    const draft = toDraft({
      name: "Mine",
      basedOn: BASE.id,
      baseSections: BASE_SECTIONS,
      sections: BASE_SECTIONS,
      options: { tone: "neutral", length: "standard", outputLanguage: "auto" },
    });
    expect(draft.sections).toEqual([]);
    expect(draft.basedOn).toBe(BASE.id);
  });
});

describe("reordering", () => {
  it("swaps a section with its neighbour", () => {
    expect(moveSection(BASE_SECTIONS, 1, -1).map((s) => s.id)).toEqual(["two", "one", "three"]);
    expect(moveSection(BASE_SECTIONS, 1, 1).map((s) => s.id)).toEqual(["one", "three", "two"]);
  });

  it("leaves the list alone at the edges", () => {
    expect(moveSection(BASE_SECTIONS, 0, -1)).toEqual(BASE_SECTIONS);
    expect(moveSection(BASE_SECTIONS, 2, 1)).toEqual(BASE_SECTIONS);
  });
});

describe("new section ids", () => {
  it("cannot collide with the base section ids", () => {
    const ids = new Set(Array.from({ length: 50 }, () => newSectionId()));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(BASE_SECTIONS.some((s) => s.id === id)).toBe(false);
  });
});
