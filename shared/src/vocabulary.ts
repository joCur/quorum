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
 * (`Systran/faster-whisper-*`, faster-whisper 1.1.1), assembling the prompt exactly as
 * `buildVocabularyPrompt` below does:
 *
 *   - a 50-term glossary of ordinary product names, people and acronyms — 187 tokens;
 *   - the same 50 slots filled with long German compounds and accented names — 240 tokens, i.e.
 *     over budget, which is why the cap is not 50;
 *   - 40 of those same hostile terms — 171 tokens, a 23% margin under the 223 available.
 *
 * Hence `MAX_VOCABULARY_TERMS = 40`. A term count alone cannot bound the token count, though —
 * forty entries of the maximum length are four times the text forty ordinary terms are, and how
 * many tokens a term costs depends far more on how unusual it is than on how long it is. So
 * `VOCABULARY_PROMPT_BUDGET` is the second half of the cap, and the pair was verified by filling
 * both to whichever binds first across corpora chosen to be awkward in different ways:
 *
 *   product names      39 terms, 412 units — 158 tokens
 *   acronyms           40 terms, 235 units — 165 tokens
 *   accented names     23 terms, 417 units — 206 tokens
 *   German compounds   14 terms, 398 units — 126 tokens
 *   hyphenated jargon  20 terms, 410 units — 171 tokens
 *   maximum-length     10 terms, 393 units — 207 tokens
 *
 * The worst of them lands 16 tokens under the budget, and an ordinary glossary reaches the term
 * cap rather than the budget — which is what makes "X of 40 terms" an honest thing to show.
 *
 * WHY THE BUDGET IS NOT COUNTED IN CHARACTERS. Every corpus above is Latin script, and a budget
 * calibrated on them does not bound a list written in another one. Measured tokens per code point:
 *
 *   Latin acronyms 0.53 · Cyrillic 0.44 · Greek 0.62 · Arabic 0.62 · emoji 0.61
 *   Korean 0.93 · Japanese 1.12 · Chinese terms 1.33 · Chinese names 1.45
 *
 * A list of Chinese names is nearly three times as expensive per character as the worst Latin
 * corpus, so 420 characters of it is roughly 600 tokens — it would pass all three caps and then
 * lose its front to the backend's silent trim, which is exactly the failure the caps exist to
 * prevent. The budget is therefore spent in *weighted code points* (`codePointCost`), not
 * characters: code points, because `String.length` counts UTF-16 units and undercounts every
 * astral character; weighted, because how much a code point costs to tokenize depends on its
 * script. Filling both caps again with the weights in place, every script lands inside the window:
 *
 *   product names 40 terms — 180 tokens      Chinese names 32 terms — 201 tokens
 *   accented names 24 terms — 188 tokens     Chinese terms 21 terms — 159 tokens
 *   hyphenated 20 terms — 170 tokens         Japanese 25 terms — 150 tokens
 *   acronyms 40 terms — 161 tokens           Korean 23 terms — 123 tokens
 *   German compounds 14 terms — 127 tokens   Arabic 26 terms — 165 tokens
 *   emoji 28 terms — 192 tokens              Greek 15 terms — 142 tokens
 *                                            Cyrillic 19 terms — 98 tokens
 *
 * Worst case 201 of 223.
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
 * Longest single term, in weighted code points — the same unit the budget is spent in, so one
 * entry cannot buy more room by being written in a costlier script. A vocabulary entry is a name
 * or a short phrase; the longest compound in the measured corpus was 33 characters.
 */
export const MAX_VOCABULARY_TERM_LENGTH = 40;

/**
 * What the assembled term list may cost, separators included, in the weighted code points
 * `codePointCost` counts. One unit is one Latin code point; see the derivation above.
 */
export const VOCABULARY_PROMPT_BUDGET = 420;

/**
 * What one code point costs against the budget, by script.
 *
 * One unit is calibrated to the worst Latin corpus measured, 0.53 tokens per code point. The
 * weights below are what it takes for every other script to fit the same budget, measured the same
 * way — and a single "non-Latin" bucket does not work in either direction. Tokens per code point:
 *
 *   Latin 0.53 · Cyrillic 0.44 · Greek 0.62 · Arabic 0.62 — cost 1 to 2
 *   Korean 0.93 · Japanese 1.12 · Chinese terms 1.33 · Chinese names 1.45 — cost 5
 *
 * Pricing Greek and Cyrillic like Chinese would be wrong twice over: they are as cheap as Latin,
 * and at cost 5 an ordinary Greek word exceeds the per-term cap on its own, so those vocabularies
 * would simply stop working. Pricing Chinese like Latin is the silent overflow this exists to
 * prevent — a 40-name list is 253 tokens at cost 3, and 201 at cost 5.
 *
 * The default is the expensive one. An unmeasured script has to be assumed costly, because
 * guessing low fails silently at the backend while guessing high only costs the user some room.
 * The practical effect on the expensive scripts is a term limit of eight code points, which is a
 * long name in any of them.
 */
const LATIN_CODE_POINT_COST = 1;
const ALPHABETIC_CODE_POINT_COST = 2;
const IDEOGRAPHIC_CODE_POINT_COST = 5;

function codePointWeight(codePoint: number): number {
  // ASCII through Latin Extended-B, plus the combining diacritics decomposed Latin text carries.
  if (codePoint <= 0x024f) return LATIN_CODE_POINT_COST;
  if (codePoint >= 0x0300 && codePoint <= 0x036f) return LATIN_CODE_POINT_COST;
  // Greek, Cyrillic, Armenian, Hebrew, Arabic — alphabetic, and about as cheap as Latin.
  if (codePoint >= 0x0370 && codePoint <= 0x06ff) return ALPHABETIC_CODE_POINT_COST;
  // Georgian, likewise alphabetic.
  if (codePoint >= 0x10a0 && codePoint <= 0x10ff) return ALPHABETIC_CODE_POINT_COST;
  // Everything else: CJK, Hangul, Kana, the scripts nobody has measured, and every astral
  // character including emoji.
  return IDEOGRAPHIC_CODE_POINT_COST;
}

/** What one string costs against the budget. */
export function codePointCost(text: string): number {
  let cost = 0;
  // Iterating the string yields whole code points, so an astral character counts once — and at
  // its real weight — rather than as two cheap UTF-16 units.
  for (const character of text) {
    cost += codePointWeight(character.codePointAt(0) ?? 0);
  }
  return cost;
}

/** What separates two terms in the prompt, and what the budget charges for one. */
const TERM_SEPARATOR = ", ";

/**
 * One stored term.
 *
 * Trimmed and collapsed rather than rejected for stray whitespace: a term is usually pasted, and
 * refusing "  Keycloak " teaches nothing. Line breaks collapse to a space for the same reason —
 * and because a newline in the prompt would be read as a sentence boundary.
 *
 * The length limit is in weighted code points rather than in `String.length`, for the reasons the
 * file comment gives.
 */
export const VocabularyTermSchema = z
  .string()
  .transform((value) => value.replace(/\s+/gu, " ").trim())
  .pipe(
    z
      .string()
      .min(1)
      .refine((term) => codePointCost(term) <= MAX_VOCABULARY_TERM_LENGTH),
  );

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
  .pipe(z.array(z.string()).max(MAX_VOCABULARY_TERMS).refine(withinPromptBudget));

export type VocabularyTerm = z.infer<typeof VocabularyTermSchema>;
export type Vocabulary = z.infer<typeof VocabularySchema>;

/** Why a term could not be added, in the terms the settings screen explains it in. */
export type VocabularyRejection =
  "empty" | "duplicate" | "too-long" | "list-full" | "budget-exhausted";

/**
 * The locale every comparison in this file is pinned to.
 *
 * NOT the host locale, which is what `toLocaleLowerCase()` and a bare `localeCompare()` would use.
 * Two concrete failures that causes: under a Turkish locale "MINIO" lowercases to "mınio" with a
 * dotless i, so the browser's duplicate check passes and the server's — running under its own
 * locale — folds the term away, and it silently never appears; and a sort order that differs
 * between the screen and the server means the list a user reads is not the order the prompt is
 * assembled in. Both sides pin the same locale so both sides get the same answer.
 */
const VOCABULARY_LOCALE = "en";

const collator = new Intl.Collator(VOCABULARY_LOCALE, { sensitivity: "variant" });

/**
 * The key two spellings of one term share. `toLowerCase()` rather than `toLocaleLowerCase()`: the
 * locale-sensitive one is exactly the Turkish-i hazard described above.
 */
function foldCase(term: string): string {
  return term.toLowerCase();
}

/**
 * Deduplicated case-insensitively and sorted alphabetically, which is the order everything
 * downstream relies on.
 *
 * A collator rather than a code-point sort, so "Ärger" lands next to "Arbeit" instead of after
 * "Zoom" — pinned to one locale so client and server agree. The first spelling of a duplicate
 * wins: it is the one the user typed first, and a later one differing only in case is not new
 * information.
 */
export function normalizeVocabulary(terms: readonly string[]): string[] {
  const seen = new Map<string, string>();
  for (const term of terms) {
    const cleaned = term.replace(/\s+/gu, " ").trim();
    if (!cleaned) continue;
    const key = foldCase(cleaned);
    if (!seen.has(key)) seen.set(key, cleaned);
  }
  return [...seen.values()].sort((a, b) => collator.compare(a, b));
}

/** What the assembled list would cost — the quantity `VOCABULARY_PROMPT_BUDGET` caps. */
export function vocabularyPromptCost(terms: readonly string[]): number {
  if (terms.length === 0) return 0;
  return terms.reduce(
    (total, term) => total + codePointCost(term),
    (terms.length - 1) * TERM_SEPARATOR.length,
  );
}

function withinPromptBudget(terms: readonly string[]): boolean {
  return vocabularyPromptCost(terms) <= VOCABULARY_PROMPT_BUDGET;
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
  if (codePointCost(term) > MAX_VOCABULARY_TERM_LENGTH) return { ok: false, reason: "too-long" };
  const key = foldCase(term);
  if (existing.some((stored) => foldCase(stored) === key)) {
    return { ok: false, reason: "duplicate" };
  }
  if (existing.length >= MAX_VOCABULARY_TERMS) return { ok: false, reason: "list-full" };
  if (!withinPromptBudget([...existing, term])) {
    return { ok: false, reason: "budget-exhausted" };
  }
  return { ok: true, term };
}

/**
 * The longest prefix of a list that the caps allow, and the terms that did not fit.
 *
 * Used in two places with two different meanings. Reading a stored row, it repairs a list written
 * when the caps were wider — the terms that survive still bias the transcription, which is worth
 * more than dropping the lot. Building a request, it is a last line of defense: everything
 * upstream is supposed to have capped the list already, so anything dropped here is a defect, and
 * the caller logs it.
 *
 * A term is skipped for being individually too long and the scan carries on; the budget likewise
 * skips rather than stops, because a shorter term further down the list can still fit. Only the
 * term count ends the scan, since nothing after it could be admitted either.
 */
export function capVocabulary(terms: readonly string[]): { kept: string[]; dropped: string[] } {
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const term of normalizeVocabulary(terms)) {
    if (codePointCost(term) > MAX_VOCABULARY_TERM_LENGTH) {
      dropped.push(term);
      continue;
    }
    if (kept.length >= MAX_VOCABULARY_TERMS) {
      dropped.push(term);
      continue;
    }
    if (!withinPromptBudget([...kept, term])) {
      dropped.push(term);
      continue;
    }
    kept.push(term);
  }
  return { kept, dropped };
}

/** An assembled prompt, and whatever the caps refused to let into it. */
export interface VocabularyPromptResult {
  /** The `prompt` field to send, or `undefined` when there is nothing to say. */
  prompt: string | undefined;
  /** Terms left out. Empty whenever the caps upstream did their job — a warning sign if not. */
  dropped: string[];
}

/**
 * Assembles the `prompt` field of the transcription request.
 *
 * A bare comma-separated list, which is what the API's own guidance recommends for exactly this
 * purpose and what the budget above was measured against. No carrier sentence: it would spend
 * tokens on words that bias nothing, and Whisper is being shown a sample of the vocabulary it is
 * about to hear, not being given an instruction.
 *
 * `undefined` and not an empty string, so a request for a user with no vocabulary carries no
 * `prompt` field at all rather than an empty one — a backend that treats the two differently then
 * sees the same request it saw before this feature existed.
 *
 * WHY IT CAPS AGAIN HERE. The list should already be within the caps — the screen and the API both
 * enforce them. But this is the last point before the text reaches a backend that would trim it
 * silently and from the *front*, so a list that got past the caps anyway (a schema regression, a
 * newer API storing wider lists than an older worker knows about, a hand-enqueued job) must not
 * take the whole vocabulary's head off. Capping here keeps the front, drops the tail, and reports
 * what went — a loud, ordered degradation instead of a silent, arbitrary one.
 */
export function buildVocabularyPrompt(
  terms: readonly string[] | null | undefined,
): VocabularyPromptResult {
  const { kept, dropped } = capVocabulary(terms ?? []);
  if (kept.length === 0) return { prompt: undefined, dropped };
  return { prompt: `${kept.join(TERM_SEPARATOR)}.`, dropped };
}

/** The prompt alone, for callers with nothing useful to do about a term that did not fit. */
export function vocabularyPrompt(terms: readonly string[] | null | undefined): string | undefined {
  return buildVocabularyPrompt(terms).prompt;
}
