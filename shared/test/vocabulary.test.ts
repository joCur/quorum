import { describe, expect, it } from "vitest";
import {
  MAX_VOCABULARY_TERMS,
  MAX_VOCABULARY_TERM_LENGTH,
  TRANSCRIPTION_PROMPT_TOKEN_BUDGET,
  VOCABULARY_CHARACTER_BUDGET,
  VocabularySchema,
  canAddVocabularyTerm,
  normalizeVocabulary,
  vocabularyCharacterCount,
  vocabularyPrompt,
} from "../src/vocabulary.js";

describe("normalizing a vocabulary", () => {
  it("sorts alphabetically, which is the order everything downstream depends on", () => {
    // The settings screen, the stored row and the prompt all show the same list in the same
    // order, so the user can see exactly what is sent.
    expect(normalizeVocabulary(["Zod", "Ansible", "MinIO"])).toEqual(["Ansible", "MinIO", "Zod"]);
  });

  it("sorts by locale rather than by code point", () => {
    // A code-point sort would put "Ärger" after "Zoom" and make the list look shuffled to anyone
    // whose terms are not pure ASCII.
    expect(normalizeVocabulary(["Zoom", "Ärger", "Arbeit"])).toEqual(["Arbeit", "Ärger", "Zoom"]);
  });

  it("drops a case-insensitive duplicate and keeps the spelling typed first", () => {
    // Two spellings of one word are not two terms, and keeping both would spend two of the
    // limited slots on one thing.
    expect(normalizeVocabulary(["Keycloak", "keycloak", "KEYCLOAK"])).toEqual(["Keycloak"]);
  });

  it("collapses whitespace and drops entries that were only whitespace", () => {
    // Terms are usually pasted. A newline in particular must not survive: the prompt would read
    // it as a sentence boundary.
    expect(normalizeVocabulary(["  MinIO  ", "pg\n boss", "   ", ""])).toEqual([
      "MinIO",
      "pg boss",
    ]);
  });
});

describe("the caps derived from the prompt budget", () => {
  it("counts the characters the assembled list actually occupies", () => {
    // Separators are charged for, because they are what the backend has to tokenize too.
    expect(vocabularyCharacterCount([])).toBe(0);
    expect(vocabularyCharacterCount(["abc"])).toBe(3);
    expect(vocabularyCharacterCount(["abc", "de"])).toBe(7);
  });

  it("accepts a full-length list of ordinary terms", () => {
    const terms = Array.from({ length: MAX_VOCABULARY_TERMS }, (_, index) => `Term${index}`);
    expect(VocabularySchema.parse(terms)).toHaveLength(MAX_VOCABULARY_TERMS);
  });

  it("refuses one term past the cap", () => {
    const terms = Array.from({ length: MAX_VOCABULARY_TERMS + 1 }, (_, index) => `Term${index}`);
    expect(VocabularySchema.safeParse(terms).success).toBe(false);
  });

  it("refuses a list that fits the count but not the character budget", () => {
    // The count alone cannot bound the prompt: a handful of long terms is more text than a full
    // list of short ones, which is why the character budget exists at all.
    const long = "A".repeat(MAX_VOCABULARY_TERM_LENGTH);
    const terms = Array.from({ length: 20 }, (_, index) => `${long.slice(1)}${index}`);
    expect(vocabularyCharacterCount(terms)).toBeGreaterThan(VOCABULARY_CHARACTER_BUDGET);
    expect(VocabularySchema.safeParse(terms).success).toBe(false);
  });

  it("refuses a single term longer than one entry may be", () => {
    expect(VocabularySchema.safeParse(["A".repeat(MAX_VOCABULARY_TERM_LENGTH + 1)]).success).toBe(
      false,
    );
  });

  it("keeps the character budget inside the token budget it was derived from", () => {
    // The budget was measured against the tokenizer the serving backend uses; the worst corpus
    // tried landed at 207 tokens. This guards the arithmetic that relates the two numbers, so a
    // later widening of the character budget cannot silently outgrow the prompt window.
    const CONSERVATIVE_CHARS_PER_TOKEN = 2;
    expect(VOCABULARY_CHARACTER_BUDGET / CONSERVATIVE_CHARS_PER_TOKEN).toBeLessThanOrEqual(
      TRANSCRIPTION_PROMPT_TOKEN_BUDGET,
    );
  });
});

describe("deciding whether one more term fits", () => {
  const full = Array.from({ length: MAX_VOCABULARY_TERMS }, (_, index) => `T${index}`);

  it("accepts and cleans up an ordinary term", () => {
    expect(canAddVocabularyTerm(["Ansible"], "  MinIO ")).toEqual({ ok: true, term: "MinIO" });
  });

  it("says nothing was typed rather than adding an empty term", () => {
    expect(canAddVocabularyTerm([], "   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("recognizes a duplicate regardless of case", () => {
    expect(canAddVocabularyTerm(["Keycloak"], "keycloak")).toEqual({
      ok: false,
      reason: "duplicate",
    });
  });

  it("refuses a term longer than one entry may be", () => {
    expect(canAddVocabularyTerm([], "A".repeat(MAX_VOCABULARY_TERM_LENGTH + 1))).toEqual({
      ok: false,
      reason: "too-long",
    });
  });

  it("refuses once the list is full, and says that is why", () => {
    expect(canAddVocabularyTerm(full, "MinIO")).toEqual({ ok: false, reason: "list-full" });
  });

  it("distinguishes a full list from an exhausted budget", () => {
    // The two are different problems with the same remedy, and a user who has ten long terms
    // deserves to be told which one they have run into.
    const long = Array.from({ length: 15 }, (_, index) => `${"A".repeat(30)}${index}`);
    expect(canAddVocabularyTerm(long, "MinIO")).toEqual({
      ok: false,
      reason: "budget-exhausted",
    });
  });

  it("refuses a duplicate before it refuses a full list", () => {
    // Telling a user to remove a term to make room for one already on the list would be wrong
    // twice over.
    expect(canAddVocabularyTerm(full, full[0] as string)).toEqual({
      ok: false,
      reason: "duplicate",
    });
  });
});

describe("assembling the transcription prompt", () => {
  it("joins the terms in sorted order, as a single sentence", () => {
    expect(vocabularyPrompt(["MinIO", "Ansible", "Zod"])).toBe("Ansible, MinIO, Zod.");
  });

  it("normalizes on the way through, so the prompt matches the stored list", () => {
    expect(vocabularyPrompt([" keycloak ", "Keycloak", "Ansible"])).toBe("Ansible, keycloak.");
  });

  it("sends nothing at all for a user with no terms", () => {
    // Not an empty string: a request for a user with no vocabulary should be the same request the
    // backend saw before this feature existed.
    expect(vocabularyPrompt([])).toBeUndefined();
    expect(vocabularyPrompt(null)).toBeUndefined();
    expect(vocabularyPrompt(undefined)).toBeUndefined();
    expect(vocabularyPrompt(["  "])).toBeUndefined();
  });

  it("keeps a maximum list inside the character budget it was capped by", () => {
    // The whole guarantee of the feature: everything the store accepted is in the prompt, and the
    // prompt is small enough that the backend keeps all of it.
    const terms = VocabularySchema.parse(
      Array.from({ length: MAX_VOCABULARY_TERMS }, (_, index) => `Term${index}`),
    );
    const prompt = vocabularyPrompt(terms) as string;
    for (const term of terms) expect(prompt).toContain(term);
    expect(prompt.length).toBeLessThanOrEqual(VOCABULARY_CHARACTER_BUDGET + 1);
  });
});
