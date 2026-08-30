import type { SectionOverride, SummaryTemplateDraft, TemplateSection } from "@quorum/shared";

/**
 * Translation between what the editor shows and what a template stores.
 *
 * The editor works on a flat, ordered list of sections — that is what a person edits. A template
 * stores overrides against the sections it inherits (ADR-004 §1), which is what lets a later
 * improvement to the system template reach every template built on it. This module is the only
 * place that converts between the two, and it is pure so the conversion can be tested without a
 * browser.
 */

/** Two sections are the same when everything the model is told about them is the same. */
export function sectionsEqual(a: TemplateSection, b: TemplateSection): boolean {
  return a.title === b.title && a.instruction === b.instruction && a.format === b.format;
}

/** A readable, collision-free id for a section the user just added. */
export function newSectionId(): string {
  return `section-${crypto.randomUUID().slice(0, 8)}`;
}

/**
 * The overrides that turn `base` into `edited`.
 *
 * TWO SHAPES, ON PURPOSE. As long as the inherited sections keep their relative order and the
 * added ones sit at the end, the result is the minimal set of `hide`, `replace` and `add`
 * overrides — which is the shape that keeps inheritance alive: a section the user never touched
 * carries no override, so a later edit to the base reaches it.
 *
 * Reordering or interleaving cannot be said that way, because `add` appends and the schema has no
 * "move". Those cases restate the whole list: hide everything inherited, then add every section in
 * the order the user arranged. Inheritance is weaker afterwards — a section added to the base
 * later shows up at the top rather than where the user might have wanted it — but the order the
 * user chose is what they will check first, so it is the promise worth keeping.
 */
export function toOverrides(
  base: readonly TemplateSection[],
  edited: readonly TemplateSection[],
): SectionOverride[] {
  const baseById = new Map(base.map((section) => [section.id, section]));
  const editedIds = new Set(edited.map((section) => section.id));

  const keptInBaseOrder = base
    .filter((section) => editedIds.has(section.id))
    .map((section) => section.id);
  const keptInEditedOrder = edited
    .filter((section) => baseById.has(section.id))
    .map((section) => section.id);
  const orderPreserved =
    keptInBaseOrder.length === keptInEditedOrder.length &&
    keptInBaseOrder.every((id, index) => keptInEditedOrder[index] === id);

  let lastInherited = -1;
  edited.forEach((section, index) => {
    if (baseById.has(section.id)) lastInherited = index;
  });
  const additionsAtEnd = edited.every(
    (section, index) => baseById.has(section.id) || index > lastInherited,
  );

  if (!orderPreserved || !additionsAtEnd) {
    return [
      ...base.map((section) => ({
        sectionId: section.id,
        action: "hide" as const,
        section: null,
      })),
      ...edited.map((section) => ({
        sectionId: section.id,
        action: "add" as const,
        section,
      })),
    ];
  }

  const overrides: SectionOverride[] = [];
  for (const section of base) {
    if (!editedIds.has(section.id)) {
      overrides.push({ sectionId: section.id, action: "hide", section: null });
    }
  }
  for (const section of edited) {
    const inherited = baseById.get(section.id);
    if (!inherited) {
      overrides.push({ sectionId: section.id, action: "add", section });
    } else if (!sectionsEqual(inherited, section)) {
      overrides.push({ sectionId: section.id, action: "replace", section });
    }
  }
  return overrides;
}

export interface DraftInput {
  name: string;
  basedOn: string | null;
  baseSections: readonly TemplateSection[];
  sections: readonly TemplateSection[];
  options: SummaryTemplateDraft["options"];
}

/** The request body for a template the editor is holding. */
export function toDraft(input: DraftInput): SummaryTemplateDraft {
  if (input.basedOn === null) {
    return {
      name: input.name.trim(),
      basedOn: null,
      sections: [...input.sections],
      overrides: [],
      options: input.options,
    };
  }
  return {
    name: input.name.trim(),
    basedOn: input.basedOn,
    sections: [],
    overrides: toOverrides(input.baseSections, input.sections),
    options: input.options,
  };
}

/** Moves a section one step up or down, returning a new list. Out-of-range moves are no-ops. */
export function moveSection(
  sections: readonly TemplateSection[],
  index: number,
  direction: -1 | 1,
): TemplateSection[] {
  const target = index + direction;
  if (index < 0 || index >= sections.length || target < 0 || target >= sections.length) {
    return [...sections];
  }
  const next = [...sections];
  const moved = next[index] as TemplateSection;
  next[index] = next[target] as TemplateSection;
  next[target] = moved;
  return next;
}
