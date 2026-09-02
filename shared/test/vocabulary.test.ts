import { describe, expect, it } from "vitest";
import {
  MAX_VOCABULARY_TERMS,
  MAX_VOCABULARY_TERM_LENGTH,
  TRANSCRIPTION_PROMPT_TOKEN_BUDGET,
  VOCABULARY_PROMPT_BUDGET,
  VocabularySchema,
  buildVocabularyPrompt,
  canAddVocabularyTerm,
  capVocabulary,
  codePointCost,
  normalizeVocabulary,
  vocabularyPrompt,
  vocabularyPromptCost,
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
  it("counts what the assembled list actually costs", () => {
    // Separators are charged for, because they are what the backend has to tokenize too.
    expect(vocabularyPromptCost([])).toBe(0);
    expect(vocabularyPromptCost(["abc"])).toBe(3);
    expect(vocabularyPromptCost(["abc", "de"])).toBe(7);
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
    expect(vocabularyPromptCost(terms)).toBeGreaterThan(VOCABULARY_PROMPT_BUDGET);
    expect(VocabularySchema.safeParse(terms).success).toBe(false);
  });

  it("refuses a single term longer than one entry may be", () => {
    expect(VocabularySchema.safeParse(["A".repeat(MAX_VOCABULARY_TERM_LENGTH + 1)]).success).toBe(
      false,
    );
  });

  it("keeps the budget inside the token window it was derived from", () => {
    // One unit is calibrated to the worst measured Latin corpus, 0.53 tokens per code point, and
    // the weights price every other script to that same figure. This guards the arithmetic tying
    // the two numbers together, so widening the budget cannot silently outgrow the prompt window.
    const WORST_TOKENS_PER_UNIT = 0.53;
    expect(VOCABULARY_PROMPT_BUDGET * WORST_TOKENS_PER_UNIT).toBeLessThanOrEqual(
      TRANSCRIPTION_PROMPT_TOKEN_BUDGET,
    );
  });
});

describe("counting a budget that other scripts cannot escape", () => {
  it("counts a Latin code point as one unit", () => {
    expect(codePointCost("Keycloak")).toBe(8);
    // Accented Latin is still Latin: the corpora the budget was calibrated on are full of it.
    expect(codePointCost("Ärger")).toBe(5);
  });

  it("charges an ideographic code point five units", () => {
    // Measured: Chinese names cost 1.45 tokens per code point against 0.53 for the worst Latin
    // corpus. Counting them as one unit each would let a list pass every cap and still overflow
    // the prompt window — a 40-name list is 253 tokens priced at three, and 201 priced at five.
    expect(codePointCost("张伟")).toBe(10);
    expect(codePointCost("회의록")).toBe(15);
  });

  it("charges other alphabetic scripts two units, not five", () => {
    // Greek and Cyrillic measured as cheap as Latin. Pricing them like Chinese would push an
    // ordinary word past the per-term cap and make those vocabularies unusable for no reason.
    expect(codePointCost("И")).toBe(2);
    expect(codePointCost("συνεδρίαση")).toBe(20);
    expect(VocabularySchema.safeParse(["προϋπολογισμός", "Παπαδόπουλος"]).success).toBe(true);
  });

  it("counts an astral character once, not twice", () => {
    // `String.length` says 2 for a surrogate pair, which would undercount exactly the characters
    // that are most expensive to tokenize.
    expect("🚀".length).toBe(2);
    expect(codePointCost("🚀")).toBe(5);
  });

  it("refuses a list of names that would fit as characters but not as tokens", () => {
    // 40 three-character Chinese names are 120 characters — trivially inside a character budget of
    // 420, and roughly 174 tokens of prompt on their own. This is the case the weighting exists
    // for: the list is refused rather than silently losing its front at the backend.
    const names = Array.from(
      { length: 40 },
      (_, index) => `张伟${String.fromCodePoint(0x4e00 + index)}`,
    );
    expect(names.join(", ").length).toBeLessThan(VOCABULARY_PROMPT_BUDGET);
    expect(VocabularySchema.safeParse(names).success).toBe(false);
  });

  it("measures a term's own length in the same weighted units", () => {
    // Otherwise one entry could buy three times the room simply by being written in another
    // script, which is the same hole one level down.
    const twelve = "张".repeat(12);
    expect(twelve.length).toBeLessThanOrEqual(MAX_VOCABULARY_TERM_LENGTH);
    expect(VocabularySchema.safeParse([twelve]).success).toBe(false);
    // Eight is still a long name in an ideographic script, so the cap stays usable.
    expect(VocabularySchema.safeParse(["张".repeat(8)]).success).toBe(true);
  });
});

describe("pinning the locale, so both sides agree", () => {
  it("folds case the same way whatever locale the host runs under", () => {
    // Under a Turkish locale `toLocaleLowerCase` turns "MINIO" into "mınio" with a dotless i. The
    // browser would then accept the duplicate and the server would fold it away, and the term
    // would silently never appear.
    expect("MINIO".toLocaleLowerCase("tr")).not.toBe("minio");
    expect(canAddVocabularyTerm(["MinIO"], "MINIO")).toEqual({ ok: false, reason: "duplicate" });
    expect(normalizeVocabulary(["MINIO", "MinIO"])).toEqual(["MINIO"]);
  });

  it("sorts by a pinned collator rather than by the host's", () => {
    // The screen and the prompt have to be the same order, and they run in different processes
    // under different locales.
    expect(normalizeVocabulary(["Zoom", "Ärger", "Arbeit"])).toEqual(["Arbeit", "Ärger", "Zoom"]);
  });
});

describe("capping a list that got past the caps", () => {
  it("keeps everything and drops nothing when the list is already legal", () => {
    expect(capVocabulary(["MinIO", "Ansible"])).toEqual({
      kept: ["Ansible", "MinIO"],
      dropped: [],
    });
  });

  it("skips an over-long term and keeps going", () => {
    // The bug this replaces stopped at the first offender, so one legacy entry early in sort
    // order discarded every valid term after it.
    const tooLong = `A${"a".repeat(MAX_VOCABULARY_TERM_LENGTH)}`;
    const { kept, dropped } = capVocabulary([tooLong, "MinIO", "Ansible"]);

    expect(kept).toEqual(["Ansible", "MinIO"]);
    expect(dropped).toEqual([tooLong]);
  });

  it("keeps a later term that still fits after a big one did not", () => {
    // The budget check has to skip rather than stop: a short term further down the list can fit
    // in the room the rejected one would have taken.
    // Ten fillers spend 398 of the 420 units, leaving room for a two-unit term but not a
    // forty-unit one.
    const big = "B".repeat(MAX_VOCABULARY_TERM_LENGTH);
    const filler = Array.from({ length: 10 }, (_, index) => `${"A".repeat(37)}${index}`);
    const { kept } = capVocabulary([...filler, big, "zz"]);

    expect(kept).toContain("zz");
    expect(kept).not.toContain(big);
  });

  it("keeps the front of an over-long list and reports the tail", () => {
    // Front, not tail: the backend's own trim keeps the tail, so degrading the same way would be
    // no improvement. Alphabetical order at least makes it predictable.
    const terms = Array.from(
      { length: MAX_VOCABULARY_TERMS + 5 },
      (_, i) => `Term${String(i).padStart(2, "0")}`,
    );
    const { kept, dropped } = capVocabulary(terms);

    expect(kept).toHaveLength(MAX_VOCABULARY_TERMS);
    expect(kept[0]).toBe("Term00");
    expect(dropped).toHaveLength(5);
  });
});

describe("the prompt builder's last line of defense", () => {
  it("reports nothing dropped for a list within the caps", () => {
    expect(buildVocabularyPrompt(["MinIO", "Ansible"])).toEqual({
      prompt: "Ansible, MinIO.",
      dropped: [],
    });
  });

  it("trims a list that should never have reached it, and says what it lost", () => {
    // A schema regression, a newer API against an older worker, a hand-enqueued job: the prompt
    // must not silently lose its head at the backend, so it is trimmed here and reported.
    const terms = Array.from({ length: 200 }, (_, i) => `Term${String(i).padStart(3, "0")}`);
    const { prompt, dropped } = buildVocabularyPrompt(terms);

    expect(prompt).toContain("Term000");
    expect(prompt).not.toContain("Term199");
    expect(dropped.length).toBeGreaterThan(0);
    expect(vocabularyPromptCost((prompt as string).split(", "))).toBeLessThanOrEqual(
      VOCABULARY_PROMPT_BUDGET + 1,
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
    expect(prompt.length).toBeLessThanOrEqual(VOCABULARY_PROMPT_BUDGET + 1);
  });
});
