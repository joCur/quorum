import { z } from "zod";

/**
 * The user's own list of terms — product names, people, jargon — handed to the transcription
 * backend so it recognizes them instead of writing down whatever sounds closest.
 *
 * HOW IT WORKS, AND WHAT IT IS NOT: the OpenAI-compatible transcription API takes a `prompt`, which
 * Whisper consumes as text that precedes the recording. Terms in it become far more likely to be
 * produced, and that is the whole mechanism — it is biasing, not a dictionary and not a
 * substitution pass. A term in the list may still come out wrong, and a word not in it is not
 * suppressed.
 *
 * THE BUDGET IS THE DESIGN CONSTRAINT. Whisper's decoder reserves half of its 448-token text
 * context for the prompt, and the serving backend keeps only the tail that fits: faster-whisper
 * (what `speaches` runs) slices `initial_prompt` to its last `448 / 2 - 1` tokens and says nothing
 * about it. An over-long list is therefore not rejected — it silently loses its beginning, which
 * is the worst possible failure for a feature whose point is that a specific term gets through. So
 * the list is capped at the point of entry instead, and everything stored is guaranteed to be sent.
 *
 * WHERE THE NUMBERS COME FROM. Measured against the tokenizer the serving backend actually uses
 * (`Systran/faster-whisper-*`, tokenizers 0.x, faster-whisper 1.1.1), assembling the prompt exactly
 * as `vocabularyPrompt` below does:
 *
 *   - a 50-term glossary of ordinary product names, people and acronyms — 187 tokens;
 *   - the same 50 slots filled with long German compounds and accented names — 240 tokens, i.e.
 *     over budget, which is why the cap is not 50;
 *   - 40 of those same hostile terms — 171 tokens, a 23% margin under the 223 available.
 *
 * Hence `MAX_VOCABULARY_TERMS = 40`. A term count alone cannot bound the token count, though —
 * forty entries of the maximum length are four times the text forty ordinary terms are, and how
 * many tokens a term costs depends far more on how unusual it is than on how long it is. So the
 * character budget below is the second half of the cap, and the pair was verified by filling both
 * to whichever binds first across corpora chosen to be awkward in different ways:
 *
 *   product names      39 terms, 412 characters — 158 tokens
 *   acronyms           40 terms, 235 characters — 165 tokens
 *   accented names     23 terms, 417 characters — 206 tokens
 *   German compounds   14 terms, 398 characters — 126 tokens
 *   hyphenated jargon  20 terms, 410 characters — 171 tokens
 *   maximum-length     10 terms, 393 characters — 207 tokens
 *
 * The worst of them lands 16 tokens under the budget, and an ordinary glossary reaches the term
 * cap rather than the character one — which is what makes "X of 40 terms" an honest thing to show.
 */

/**
 * Tokens the serving backend keeps of the prompt: `448 / 2 - 1`, read off faster-whisper's
 * `WhisperModel.get_prompt`. Not sent anywhere — it is the number the caps below are derived from,
 * and the reason they exist.
 */
export const TRANSCRIPTION_PROMPT_TOKEN_BUDGET = 223;

/** How many terms one user may store. See the derivation above. */
export const MAX_VOCABULARY_TERMS = 40;

/**
 * Longest single term. A vocabulary entry is a name or a short phrase; the longest compound in the
 * measured corpus was 33 characters, and 40 leaves room without letting one entry take a sixth of
 * the whole budget.
 */
export const MAX_VOCABULARY_TERM_LENGTH = 40;

/**
 * Characters the assembled term list may occupy, separators included. The backstop that keeps the
 * term count honest when the terms are long; see the derivation above.
 */
export const VOCABULARY_CHARACTER_BUDGET = 420;

/** What separates two terms in the prompt, and what the character budget charges for one. */
const TERM_SEPARATOR = ", ";

/**
 * One stored term.
 *
 * Trimmed and collapsed rather than rejected for stray whitespace: a term is usually pasted, and
 * refusing "  Keycloak " teaches nothing. Line breaks collapse to a space for the same reason —
 * and because a newline in the prompt would be read as a sentence boundary.
 */
export const VocabularyTermSchema = z
  .string()
  .transform((value) => value.replace(/\s+/gu, " ").trim())
  .pipe(z.string().min(1).max(MAX_VOCABULARY_TERM_LENGTH));

/**
 * The stored list.
 *
 * Sorted and deduplicated on the way in rather than on the way out, so what the settings screen
 * shows, what the store holds and what the prompt says are one and the same order. Both are done
 * case-insensitively: "Keycloak" and "keycloak" are the same term to a user, and keeping both would
 * spend two of forty slots on one word.
 */
export const VocabularySchema = z
  .array(VocabularyTermSchema)
  .transform(normalizeVocabulary)
  .pipe(z.array(z.string()).max(MAX_VOCABULARY_TERMS).refine(withinCharacterBudget));

export type VocabularyTerm = z.infer<typeof VocabularyTermSchema>;
export type Vocabulary = z.infer<typeof VocabularySchema>;

/** Why a term could not be added, in the terms the settings screen explains it in. */
export type VocabularyRejection =
  "empty" | "duplicate" | "too-long" | "list-full" | "budget-exhausted";

/**
 * Deduplicated case-insensitively and sorted alphabetically, which is the order everything
 * downstream relies on.
 *
 * `localeCompare` rather than a code-point sort, so "Ärger" lands next to "Arbeit" instead of after
 * "Zoom". The first spelling of a duplicate wins: it is the one the user typed first, and a later
 * one differing only in case is not new information.
 */
export function normalizeVocabulary(terms: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const term of terms) {
    const cleaned = term.replace(/\s+/gu, " ").trim();
    if (!cleaned) continue;
    const key = cleaned.toLocaleLowerCase();
    if (!seen.has(key)) seen.set(key, cleaned);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Characters the assembled list would occupy — the quantity `VOCABULARY_CHARACTER_BUDGET` caps. */
export function vocabularyCharacterCount(terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  return terms.reduce(
    (total, term) => total + term.length,
    (terms.length - 1) * TERM_SEPARATOR.length,
  );
}

function withinCharacterBudget(terms: readonly string[]): boolean {
  return vocabularyCharacterCount(terms) <= VOCABULARY_CHARACTER_BUDGET;
}

/**
 * Whether one more term fits, and why it does not.
 *
 * Shared rather than reimplemented in the settings screen, because the screen refusing an entry and
 * the API refusing it have to agree exactly: a term the screen accepts and the store rejects would
 * disappear on the next reload with no explanation.
 */
export function canAddVocabularyTerm(
  existing: readonly string[],
  candidate: string,
): { ok: true; term: string } | { ok: false; reason: VocabularyRejection } {
  const term = candidate.replace(/\s+/gu, " ").trim();
  if (!term) return { ok: false, reason: "empty" };
  if (term.length > MAX_VOCABULARY_TERM_LENGTH) return { ok: false, reason: "too-long" };
  const key = term.toLocaleLowerCase();
  if (existing.some((stored) => stored.toLocaleLowerCase() === key)) {
    return { ok: false, reason: "duplicate" };
  }
  if (existing.length >= MAX_VOCABULARY_TERMS) return { ok: false, reason: "list-full" };
  if (!withinCharacterBudget([...existing, term])) {
    return { ok: false, reason: "budget-exhausted" };
  }
  return { ok: true, term };
}

/**
 * The `prompt` field of the transcription request, or `undefined` when there is nothing to say.
 *
 * A bare comma-separated list, which is what the API's own guidance recommends for exactly this
 * purpose and what the budget above was measured against. No carrier sentence: it would spend
 * tokens on words that bias nothing, and Whisper is being shown a sample of the vocabulary it is
 * about to hear, not being given an instruction.
 *
 * `undefined` and not an empty string, so a request for a user with no vocabulary carries no
 * `prompt` field at all rather than an empty one — a backend that treats the two differently then
 * sees the same request it saw before this feature existed.
 */
export function vocabularyPrompt(terms: readonly string[] | null | undefined): string | undefined {
  const normalized = normalizeVocabulary(terms ?? []);
  if (normalized.length === 0) return undefined;
  return `${normalized.join(TERM_SEPARATOR)}.`;
}
