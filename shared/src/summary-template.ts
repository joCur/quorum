import type { SummaryTemplate, TemplateSection } from "./summary.js";

/**
 * Template resolution (ADR-004 §1).
 *
 * This lives in `shared` rather than in the worker because three sides need the
 * exact same answer: the worker builds the prompt from it, the API validates
 * that a stored template still resolves to something usable, and the editor
 * previews it. A second implementation would eventually disagree with the
 * snapshot a summary was actually produced with.
 */

/**
 * Id of the system default template (ADR-004 §1).
 *
 * A fixed constant rather than a generated one, and shared rather than worker-local,
 * because three sides name it: the worker seeds the row, the API uses it as the
 * default `basedOn` and as the default template of a summary run, and a summary's
 * snapshot has to keep pointing at something recognizable years later.
 */
export const SYSTEM_TEMPLATE_ID = "0b7a1f4d-2c3e-4a55-9f61-8d5c4a2b7e10";

export class TemplateResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateResolutionError";
  }
}

/**
 * Resolves a template into the ordered section list a summary is produced from.
 *
 * INHERITANCE (exactly one level, ADR-004 §1): a template with `basedOn` starts
 * from the *current* sections of its base and applies its own overrides on top.
 * That is the whole point of storing overrides instead of a copy — an edit to
 * the system template reaches every user template built on it, while the user's
 * own changes survive. A template with `basedOn` therefore ignores its own
 * `sections` array: everything it wants to say about sections it says as an
 * override, so there is one unambiguous source of order.
 *
 * OVERRIDES:
 * - `add` appends a section that is not there yet; if the id already exists it
 *   behaves like `replace`, because two sections with one id would be ambiguous
 *   downstream.
 * - `replace` swaps a section in place, keeping its position so the reading
 *   order of the base template survives.
 * - `hide` removes it.
 *
 * Reordering is expressed as `hide` followed by `add` for the sections that
 * move, since `add` appends — the editor emits that pair, and the resolution
 * rules stay this short.
 *
 * The result is what gets snapshotted and what the prompt is built from — the
 * same list, so the model can never be asked for a section the snapshot does
 * not describe.
 */
export function resolveTemplateSections(
  template: SummaryTemplate,
  base: SummaryTemplate | null = null,
): TemplateSection[] {
  const resolved: TemplateSection[] = [...baseSections(template, base)];

  for (const override of template.overrides) {
    const index = resolved.findIndex((section) => section.id === override.sectionId);

    if (override.action === "hide") {
      if (index >= 0) resolved.splice(index, 1);
      continue;
    }

    const section = override.section;
    if (!section) {
      throw new TemplateResolutionError(
        `override "${override.action}" for section "${override.sectionId}" carries no section`,
      );
    }
    if (index >= 0) resolved.splice(index, 1, section);
    else resolved.push(section);
  }

  if (resolved.length === 0) {
    throw new TemplateResolutionError(`template ${template.id} resolves to no sections`);
  }
  return resolved;
}

function baseSections(
  template: SummaryTemplate,
  base: SummaryTemplate | null,
): readonly TemplateSection[] {
  if (template.basedOn === null) return template.sections;
  if (base === null) {
    throw new TemplateResolutionError(
      `template ${template.id} inherits from ${template.basedOn}, which was not supplied`,
    );
  }
  if (base.id !== template.basedOn) {
    throw new TemplateResolutionError(
      `template ${template.id} inherits from ${template.basedOn}, not from ${base.id}`,
    );
  }
  // One level only: the base is resolved with no base of its own, so a chain
  // longer than two can never form even if the data suggested one.
  return resolveTemplateSections({ ...base, basedOn: null });
}

/**
 * The language the summary is actually written in.
 *
 * `auto` is the stored default and means "follow the recording". Resolving it
 * against the transcript's detected language here — rather than leaving the
 * model to infer it from the transcript text — is what stops a German meeting
 * from coming back in English. A user who picks a language explicitly always
 * wins; the transcript is only consulted for `auto`.
 *
 * The resolved value is what goes into the snapshot, so an existing summary can
 * always say which language it was asked for.
 */
export function resolveOutputLanguage(
  outputLanguage: string,
  transcriptLanguage: string | null | undefined,
): string {
  if (outputLanguage !== "auto") return outputLanguage;
  const detected = transcriptLanguage?.trim();
  // Whisper reports `auto` when it could not commit to a language; there is
  // nothing better to fall back to than letting the model read the transcript.
  if (!detected || detected === "auto") return "auto";
  return detected;
}
