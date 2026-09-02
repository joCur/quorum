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

/**
 * Quote characters a model puts around a title when it treats it as a quotation, as the pairs
 * they actually come in. A closing character is only accepted for the opening one it belongs
 * with, so `«Titel»` is unwrapped and a title that merely contains quotes is left alone.
 */
const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ["'", "'"],
  ["“", "”"],
  ["„", "“"],
  ["„", "”"],
  ["«", "»"],
];

/**
 * Answers that mean "no title" while being a string.
 *
 * The prompt asks for `null`, and weaker models spell it instead. Storing the word would put
 * "N/A" at the top of a meeting screen, which is worse than the translated placeholder.
 */
const NOT_A_TITLE = new Set([
  "null",
  "none",
  "nil",
  "n/a",
  "na",
  "undefined",
  "unknown",
  "no title",
  "untitled",
]);

/** At least one letter or digit. Anything else is decoration, not a name. */
function hasWord(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

/**
 * Removes one wrapping quote pair, but only when the text between them holds no loose quote of
 * its own: stripping unconditionally turns `"Budget" und "Personal"` into a title that opens a
 * quotation it never closes.
 */
function unwrapQuotes(value: string): string {
  for (const [open, close] of QUOTE_PAIRS) {
    if (!value.startsWith(open) || !value.endsWith(close)) continue;
    if (value.length <= open.length + close.length) continue;
    const inner = value.slice(open.length, value.length - close.length).trim();
    if (inner.includes(open) || inner.includes(close)) return value;
    return inner;
  }
  return value;
}

/**
 * A model's title as it can be stored, or `null` when nothing usable came back.
 *
 * Everything here is cosmetic repair of the shapes models reliably produce: surrounding quotes,
 * a trailing full stop, newlines from a "Title: ..." line that came with its own layout. A title
 * longer than the cap is cut at a word boundary rather than rejected — the first clause of an
 * over-long title is still a better name than no name at all.
 *
 * The cut counts code points rather than UTF-16 units: slicing a title of emoji or of characters
 * outside the basic plane at a unit boundary splits a surrogate pair and stores a replacement
 * character. Whatever survives the cut faces the same "is this a name at all" check as the whole
 * answer did, so an answer that opens with a rule of dashes cannot store the dashes.
 */
export function normalizeGeneratedTitle(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const collapsed = unwrapQuotes(raw.replace(/\s+/gu, " ").trim()).trim();
  // A single trailing period reads as a sentence rather than as a name; "..." is the model
  // trailing off and is left alone, because cutting it would claim the title is complete.
  const trimmed = /[^.]\.$/u.test(collapsed) ? collapsed.slice(0, -1).trim() : collapsed;
  // Punctuation alone is not a name. A row reading "-" is worse than one reading "Untitled",
  // which is at least a translated word.
  if (!hasWord(trimmed)) return null;
  if (NOT_A_TITLE.has(trimmed.toLowerCase())) return null;

  const codePoints = [...trimmed];
  if (codePoints.length <= MAX_GENERATED_TITLE_LENGTH) return trimmed;

  const cut = codePoints.slice(0, MAX_GENERATED_TITLE_LENGTH).join("");
  const lastSpace = cut.lastIndexOf(" ");
  const shortened = (
    lastSpace > MAX_GENERATED_TITLE_LENGTH / 2 ? cut.slice(0, lastSpace) : cut
  ).trim();
  return hasWord(shortened) ? shortened : null;
}

/**
 * A title a person typed, as it is stored: trimmed, and `null` when nothing is left of it.
 *
 * Every writer of the column runs it — the recording protocol, the rename endpoint, both stores
 * — so that "the user has not named this meeting" means the same thing everywhere. Without it a
 * title of spaces would be a name to the database and an empty line to the reader, and the
 * suggestion that could have filled it would be refused on account of it.
 */
export function normalizeUserTitle(title: string | null | undefined): string | null {
  if (typeof title !== "string") return null;
  const trimmed = title.trim();
  return trimmed.length === 0 ? null : trimmed;
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
