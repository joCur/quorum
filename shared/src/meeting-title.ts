/**
 * The rules for a meeting title that nobody typed (ADR-003 §2, ADR-004).
 *
 * The summary pipeline reads the transcript anyway, so it can offer a name for a recording the
 * user never named. That offer is machine output, and machine output is a suggestion: it fills an
 * empty field and it never touches one a person has written in. Keeping the decision here — a
 * pure function both the worker and its tests run — is what makes "user input wins" a property of
 * the contract rather than of one `UPDATE` statement's `WHERE` clause.
 */

/**
 * Longest generated title accepted, in characters.
 *
 * A title is a list row, so it is truncated on screen long before this. The cap exists to stop a
 * model that answers with a paragraph from storing one, not to shape the wording.
 */
export const MAX_GENERATED_TITLE_LENGTH = 120;

/** Wrapping quotes a model puts around a title when it treats it as a quotation. */
const WRAPPING_QUOTES = /^["'“”„«»]+|["'“”„«»]+$/g;

/**
 * A model's title as it can be stored, or `null` when nothing usable came back.
 *
 * Everything here is cosmetic repair of the shapes models reliably produce: surrounding quotes,
 * a trailing full stop, newlines from a "Title: ..." line that came with its own layout. A title
 * longer than the cap is cut at a word boundary rather than rejected — the first clause of an
 * over-long title is still a better name than no name at all.
 */
export function normalizeGeneratedTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const collapsed = raw.replace(/\s+/gu, " ").trim().replace(WRAPPING_QUOTES, "").trim();
  // A single trailing period reads as a sentence rather than as a name; "..." is the model
  // trailing off and is left alone, because cutting it would claim the title is complete.
  const trimmed = /[^.]\.$/u.test(collapsed) ? collapsed.slice(0, -1).trim() : collapsed;
  // Punctuation alone is not a name. A row reading "-" is worse than one reading "Untitled",
  // which is at least a translated word.
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return null;
  if (trimmed.length <= MAX_GENERATED_TITLE_LENGTH) return trimmed;

  const cut = trimmed.slice(0, MAX_GENERATED_TITLE_LENGTH);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > MAX_GENERATED_TITLE_LENGTH / 2 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * Whether a meeting is still waiting for a name.
 *
 * Blank counts as unnamed: the recording screen sends `null` for an empty field, but a title of
 * spaces could reach the row through any other writer, and to a reader it is the same empty line.
 * The client's "Untitled" is a rendering of exactly this state, never a stored value — it is a
 * translated string, and storing one language's placeholder would freeze the meeting into it.
 */
export function isUnnamedMeeting(title: string | null | undefined): boolean {
  return typeof title !== "string" || title.trim().length === 0;
}

/**
 * The title to write when a generated suggestion arrives, or `null` for "leave the row alone".
 *
 * The two answers this function exists to give:
 * - A user-entered title is kept, always. The suggestion is discarded, not queued for later.
 * - A meeting nobody named takes the suggestion, and an already generated one is not replaced by
 *   a rerun's — regenerating a summary must not rename a meeting the user has been looking at.
 */
export function generatedTitleUpdate(
  currentTitle: string | null | undefined,
  generatedTitle: string | null | undefined,
): string | null {
  if (!isUnnamedMeeting(currentTitle)) return null;
  return normalizeGeneratedTitle(generatedTitle);
}
