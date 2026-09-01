import { normalizeGeneratedTitle, type SummarySection, type TemplateSection } from "@quorum/shared";

/**
 * Turning a model's answer into `SummarySection[]`.
 *
 * The contract is one-sided on purpose. The template snapshot decides which
 * sections exist, what they are called and how they are formatted; the response
 * only contributes content, addressed by section id. Anything the model adds —
 * an extra section, a renamed title, a different order — is dropped rather than
 * stored, so a chatty model cannot reshape the document (ADR-004 §5).
 *
 * Everything here is tolerant except the one thing that cannot be recovered: an
 * answer that contains no requested section id at all. That is what triggers
 * the single repair attempt in the handler.
 *
 * The envelope carries one more thing than the sections: a suggested name for
 * the meeting. It is optional in both directions — the model may leave it out,
 * and the meeting may already have a name the user gave it.
 */

/** Signals an answer the handler should try to have repaired once. */
export class SummaryParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SummaryParseError";
  }
}

/**
 * Digs the JSON value out of an answer.
 *
 * Models wrap JSON in ```json fences, prefix it with "Here is the summary:", or
 * append a closing remark, no matter how the prompt is worded. Rather than
 * failing on any of that, the extractor takes the substring from the first
 * opening bracket to its matching closing one — with a fenced block preferred
 * when one is present, because prose around a fence may itself contain braces.
 *
 * Arrays are extracted too: a model that skips the envelope and answers with a
 * bare list of sections is answering usefully, and slicing from the first `{`
 * would silently keep only its first element.
 */
export function extractJsonObject(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const candidate = fenced?.[1]?.trim() ?? raw.trim();

  const braceStart = candidate.indexOf("{");
  const bracketStart = candidate.indexOf("[");
  const starts = [braceStart, bracketStart].filter((index) => index !== -1);
  if (starts.length === 0) {
    throw new SummaryParseError("the answer contains no JSON object");
  }

  const start = Math.min(...starts);
  const closer = candidate[start] === "[" ? "]" : "}";
  const end = candidate.lastIndexOf(closer);
  if (end <= start) {
    // An answer that begins a JSON value and never closes it is the classic
    // "stopped at max_tokens" failure. Saying so gives the repair turn — and
    // the operator reading the log — something actionable.
    throw new SummaryParseError(
      `the answer is truncated: it opens a JSON value and never closes it (expected "${closer}")`,
    );
  }
  return candidate.slice(start, end + 1);
}

function asContentItems(value: unknown): string[] {
  if (value === null || value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  return items
    .map((item) => {
      if (typeof item === "string") return item.trim();
      if (typeof item === "number" || typeof item === "boolean") return String(item);
      // A `table` row, or a model that wrapped a bullet in an object. The schema
      // stores rows as JSON strings (`shared/src/summary.ts`), so this is the
      // intended shape rather than a fallback.
      if (typeof item === "object") return JSON.stringify(item);
      return "";
    })
    .filter((item) => item.length > 0);
}

/**
 * Reads the `sections` array, but also accepts the two shapes models reach for
 * when they ignore the envelope: a bare array of sections, and an object keyed
 * by section id. Both carry the same information, and rejecting them would cost
 * a second call for nothing.
 */
function sectionEntries(parsed: unknown): Map<string, unknown> {
  const entries = new Map<string, unknown>();

  const collectArray = (items: unknown[]): void => {
    for (const item of items) {
      if (typeof item !== "object" || item === null) continue;
      const record = item as Record<string, unknown>;
      const id = record["sectionId"] ?? record["id"] ?? record["section_id"];
      if (typeof id === "string") entries.set(id, record["content"] ?? record["items"] ?? []);
    }
  };

  if (Array.isArray(parsed)) {
    collectArray(parsed);
    return entries;
  }
  if (typeof parsed !== "object" || parsed === null) return entries;

  const record = parsed as Record<string, unknown>;
  const sections = record["sections"];
  if (Array.isArray(sections)) {
    collectArray(sections);
    return entries;
  }
  if (typeof sections === "object" && sections !== null) {
    for (const [id, value] of Object.entries(sections)) entries.set(id, value);
    return entries;
  }
  // Keyed directly by section id at the top level.
  for (const [id, value] of Object.entries(record)) entries.set(id, value);
  return entries;
}

export interface ParsedSummaryContent {
  sections: SummarySection[];
  /** Sections the model left out entirely; stored empty and logged. */
  missingSectionIds: string[];
  /**
   * The suggested meeting title, normalized, or `null` when the model offered none or offered
   * something unusable. Never a reason to reject an answer: the sections are what was paid for,
   * and a summary without a title is a complete summary of a meeting that keeps its own name.
   */
  title: string | null;
}

/**
 * The title out of the answer envelope.
 *
 * `title` is read only from an object at the top level. In the two fallback shapes the parser
 * tolerates for sections — a bare array, and an object keyed by section id — there is no envelope
 * to carry one, and a section called `title` is a section, not a name for the meeting.
 */
function titleOf(parsed: unknown): string | null {
  if (Array.isArray(parsed) || typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  return normalizeGeneratedTitle(record["title"] ?? record["meetingTitle"]);
}

export function parseSummaryResponse(
  raw: string,
  templateSections: TemplateSection[],
): ParsedSummaryContent {
  const json = extractJsonObject(raw);

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (error) {
    throw new SummaryParseError(
      `the answer is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const entries = sectionEntries(parsed);
  const known = templateSections.filter((section) => entries.has(section.id));
  if (known.length === 0) {
    throw new SummaryParseError(
      `the answer contains none of the requested section ids (${templateSections
        .map((section) => section.id)
        .join(", ")})`,
    );
  }

  const missingSectionIds: string[] = [];
  const sections: SummarySection[] = templateSections.map((section) => {
    if (!entries.has(section.id)) missingSectionIds.push(section.id);
    const content = asContentItems(entries.get(section.id));
    return {
      sectionId: section.id,
      title: section.title,
      format: section.format,
      // A prose section is one paragraph by definition; a model that split it
      // into sentences gets them joined rather than stored as pseudo-bullets.
      content: section.format === "prose" && content.length > 1 ? [content.join(" ")] : content,
      // ADR-004 §4: source references stay unpopulated in V1.
      sourceSegmentIds: null,
    };
  });

  return { sections, missingSectionIds, title: titleOf(parsed) };
}
