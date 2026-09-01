import { describe, expect, it } from "vitest";
import {
  MAX_GENERATED_TITLE_LENGTH,
  generatedTitleUpdate,
  isUnnamedMeeting,
  normalizeGeneratedTitle,
} from "../src/meeting-title.js";

describe("normalizing a generated title", () => {
  it("keeps a title that is already what it should be", () => {
    expect(normalizeGeneratedTitle("Release date and follow-up work")).toBe(
      "Release date and follow-up work",
    );
  });

  it("strips the quotes and the trailing period models add", () => {
    expect(normalizeGeneratedTitle('"Quarterly planning."')).toBe("Quarterly planning");
    expect(normalizeGeneratedTitle("„Jahresplanung“")).toBe("Jahresplanung");
  });

  it("leaves an ellipsis alone, which says the title was cut off", () => {
    expect(normalizeGeneratedTitle("Budget, staffing and...")).toBe("Budget, staffing and...");
  });

  it("collapses the layout of a title that came with its own line breaks", () => {
    expect(normalizeGeneratedTitle("Sprint  review\n  and retro")).toBe("Sprint review and retro");
  });

  it("cuts an over-long title at a word boundary rather than rejecting it", () => {
    const long = `${"Budget ".repeat(40)}talk`;
    const normalized = normalizeGeneratedTitle(long)!;

    expect(normalized.length).toBeLessThanOrEqual(MAX_GENERATED_TITLE_LENGTH);
    expect(normalized.endsWith("Budget")).toBe(true);
  });

  it("reads an empty, blank or non-string answer as no title at all", () => {
    expect(normalizeGeneratedTitle("")).toBeNull();
    expect(normalizeGeneratedTitle('  ""  ')).toBeNull();
    expect(normalizeGeneratedTitle(null)).toBeNull();
    expect(normalizeGeneratedTitle(42)).toBeNull();
  });
});

describe("whether a meeting still needs a name", () => {
  it("counts absent and blank titles as unnamed", () => {
    expect(isUnnamedMeeting(null)).toBe(true);
    expect(isUnnamedMeeting(undefined)).toBe(true);
    expect(isUnnamedMeeting("   ")).toBe(true);
  });

  it("counts anything the user actually typed as named", () => {
    expect(isUnnamedMeeting("Weekly sync")).toBe(false);
  });
});

describe("offering a generated title to a meeting", () => {
  it("names a meeting the user left unnamed", () => {
    expect(generatedTitleUpdate(null, "Quarterly planning")).toBe("Quarterly planning");
  });

  it("replaces a blank title, which is the same empty line to a reader", () => {
    expect(generatedTitleUpdate("   ", "Quarterly planning")).toBe("Quarterly planning");
  });

  it("never overwrites a title the user wrote (ADR-003 section 2)", () => {
    expect(generatedTitleUpdate("Weekly sync", "Quarterly planning")).toBeNull();
  });

  it("leaves a name already suggested by an earlier run in place", () => {
    const first = generatedTitleUpdate(null, "Quarterly planning");
    expect(generatedTitleUpdate(first, "Something else entirely")).toBeNull();
  });

  it("changes nothing when the model offered no title", () => {
    expect(generatedTitleUpdate(null, null)).toBeNull();
    expect(generatedTitleUpdate(null, "   ")).toBeNull();
  });

  it("normalizes what it applies, so the stored title is the clean one", () => {
    expect(generatedTitleUpdate(null, '  "Quarterly planning."  ')).toBe("Quarterly planning");
  });
});
