import { describe, expect, it } from "vitest";
import {
  SUMMARY_SCHEMA_VERSION,
  SummaryTemplateSchema,
  SYSTEM_TEMPLATE_ID,
  TemplateResolutionError,
  resolveOutputLanguage,
  resolveTemplateSections,
  type SummaryTemplate,
  type TemplateSection,
} from "../src/index.js";

function section(id: string): TemplateSection {
  return { id, title: id, instruction: `About ${id}.`, format: "bullets" };
}

const BASE: SummaryTemplate = SummaryTemplateSchema.parse({
  id: SYSTEM_TEMPLATE_ID,
  schemaVersion: SUMMARY_SCHEMA_VERSION,
  name: "Base",
  version: 1,
  scope: "system",
  basedOn: null,
  sections: [section("one"), section("two"), section("three")],
  overrides: [],
  options: {},
});

function child(overrides: SummaryTemplate["overrides"]): SummaryTemplate {
  return SummaryTemplateSchema.parse({
    ...BASE,
    id: "7c3f0e21-1a55-4d0a-9f2b-6e8c1d4a9b33",
    name: "Child",
    scope: "user",
    sections: [],
    basedOn: BASE.id,
    overrides,
  });
}

describe("template resolution", () => {
  it("takes a standalone template's sections as they are", () => {
    expect(resolveTemplateSections(BASE).map((s) => s.id)).toEqual(["one", "two", "three"]);
  });

  it("inherits the base's sections, so a change to the base reaches the child", () => {
    const grown = SummaryTemplateSchema.parse({
      ...BASE,
      version: 2,
      sections: [...BASE.sections, section("four")],
    });
    expect(resolveTemplateSections(child([]), grown).map((s) => s.id)).toEqual([
      "one",
      "two",
      "three",
      "four",
    ]);
  });

  it("ignores an inheriting template's own sections — it speaks in overrides", () => {
    const confused = { ...child([]), sections: [section("stray")] };
    expect(resolveTemplateSections(confused, BASE).map((s) => s.id)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("expresses a reorder as hide followed by add", () => {
    const reordered = child([
      { sectionId: "one", action: "hide", section: null },
      { sectionId: "one", action: "add", section: section("one") },
    ]);
    expect(resolveTemplateSections(reordered, BASE).map((s) => s.id)).toEqual([
      "two",
      "three",
      "one",
    ]);
  });

  it("treats `add` of an existing id as a replace, keeping one section per id", () => {
    const renamed = { ...section("two"), title: "Second" };
    const resolved = resolveTemplateSections(
      child([{ sectionId: "two", action: "add", section: renamed }]),
      BASE,
    );
    expect(resolved.map((s) => s.id)).toEqual(["one", "two", "three"]);
    expect(resolved[1]).toEqual(renamed);
  });

  it("refuses a chain deeper than one level by resolving the base without its own base", () => {
    const deep = { ...BASE, basedOn: "11111111-1111-4111-8111-111111111111" };
    // The base is resolved as if it inherited from nothing, so no second hop is attempted.
    expect(resolveTemplateSections(child([]), deep as SummaryTemplate).map((s) => s.id)).toEqual([
      "one",
      "two",
      "three",
    ]);
  });

  it("refuses an inheriting template whose base was not supplied", () => {
    expect(() => resolveTemplateSections(child([]))).toThrow(TemplateResolutionError);
  });

  it("refuses a base that is not the one the template names", () => {
    const other = { ...BASE, id: "22222222-2222-4222-8222-222222222222" };
    expect(() => resolveTemplateSections(child([]), other as SummaryTemplate)).toThrow(
      TemplateResolutionError,
    );
  });

  it("refuses an add or replace override that carries no section", () => {
    expect(() =>
      resolveTemplateSections(child([{ sectionId: "four", action: "add", section: null }]), BASE),
    ).toThrow(TemplateResolutionError);
  });

  it("refuses a template that resolves to nothing at all", () => {
    const empty = child(
      BASE.sections.map((s) => ({ sectionId: s.id, action: "hide" as const, section: null })),
    );
    expect(() => resolveTemplateSections(empty, BASE)).toThrow(/resolves to no sections/);
  });
});

describe("output language", () => {
  it("follows the transcript when the template says `auto`", () => {
    expect(resolveOutputLanguage("auto", "de")).toBe("de");
  });

  it("keeps an explicit choice even when the transcript is in another language", () => {
    expect(resolveOutputLanguage("fr", "de")).toBe("fr");
  });

  it("stays on `auto` when the transcript could not name a language", () => {
    expect(resolveOutputLanguage("auto", "auto")).toBe("auto");
    expect(resolveOutputLanguage("auto", "")).toBe("auto");
    expect(resolveOutputLanguage("auto", null)).toBe("auto");
    expect(resolveOutputLanguage("auto", undefined)).toBe("auto");
  });
});
