import { describe, expect, it } from "vitest";
import { SummarySchema } from "@quorum/shared";
import { summaryIdForJob } from "../src/ids.js";
import { mapToSummary } from "../src/summary/map.js";
import {
  extractJsonObject,
  parseSummaryResponse,
  SummaryParseError,
} from "../src/summary/parse.js";
import {
  PROMPT_VERSION,
  SYSTEM_SUMMARY_TEMPLATE,
  resolveTemplateSections,
} from "../src/summary/template.js";
import { MEETING_ID } from "./helpers.js";
import {
  SUGGESTED_TITLE,
  SUMMARIZE_JOB_ID,
  TRANSCRIPT_ID,
  WELL_FORMED_ANSWER,
} from "./summary-helpers.js";

const SECTIONS = resolveTemplateSections(SYSTEM_SUMMARY_TEMPLATE);

function parse(raw: string) {
  return parseSummaryResponse(raw, SECTIONS);
}

describe("response parsing", () => {
  it("maps a well-formed answer onto the template's sections", () => {
    const { sections, missingSectionIds } = parse(WELL_FORMED_ANSWER);

    expect(missingSectionIds).toEqual([]);
    expect(sections.map((section) => section.sectionId)).toEqual(
      SECTIONS.map((section) => section.id),
    );
    expect(sections[0]).toMatchObject({ title: "Overview", format: "prose" });
    expect(sections[4]!.content).toEqual(["Who runs the customer webinar?"]);
    // ADR-004 §4: source references stay unpopulated in V1.
    expect(sections.every((section) => section.sourceSegmentIds === null)).toBe(true);
  });

  it("stores table rows as JSON strings, as the schema requires", () => {
    const actionItems = parse(WELL_FORMED_ANSWER).sections[3]!;
    expect(actionItems.format).toBe("table");
    expect(JSON.parse(actionItems.content[0]!)).toEqual({
      task: "Write the release notes",
      owner: "Mara",
      due: null,
    });
  });

  it("takes titles and order from the template, never from the model", () => {
    const answer = JSON.stringify({
      sections: [
        { sectionId: "decisions", title: "MY DECISIONS", content: ["Ship it."] },
        { sectionId: "overview", title: "Whatever", content: ["A meeting happened."] },
        { sectionId: "invented", content: ["Should be dropped."] },
      ],
    });
    const { sections } = parse(answer);

    expect(sections.map((section) => section.sectionId)).toEqual(
      SECTIONS.map((section) => section.id),
    );
    expect(sections.map((section) => section.title)).toEqual(
      SECTIONS.map((section) => section.title),
    );
    expect(sections.some((section) => section.sectionId === "invented")).toBe(false);
  });

  it("reports sections the model skipped and stores them empty", () => {
    const answer = JSON.stringify({ sections: [{ sectionId: "overview", content: ["Short."] }] });
    const { sections, missingSectionIds } = parse(answer);

    expect(missingSectionIds).toEqual([
      "key-points",
      "decisions",
      "action-items",
      "open-questions",
    ]);
    expect(sections[1]!.content).toEqual([]);
  });

  it("survives a fenced answer with prose around it", () => {
    const answer = [
      "Sure, here is the summary you asked for:",
      "```json",
      WELL_FORMED_ANSWER,
      "```",
      "Let me know if you want it shorter!",
    ].join("\n");
    expect(parse(answer).sections[0]!.content).toHaveLength(1);
  });

  it("accepts a bare array of sections", () => {
    const answer = JSON.stringify([{ sectionId: "overview", content: ["It happened."] }]);
    expect(parse(answer).sections[0]!.content).toEqual(["It happened."]);
  });

  it("accepts an object keyed by section id", () => {
    const answer = JSON.stringify({ overview: ["It happened."], decisions: [] });
    expect(parse(answer).sections[0]!.content).toEqual(["It happened."]);
  });

  it("joins a prose section the model split into sentences", () => {
    const answer = JSON.stringify({
      sections: [{ sectionId: "overview", content: ["First part.", "Second part."] }],
    });
    expect(parse(answer).sections[0]!.content).toEqual(["First part. Second part."]);
  });

  it("drops empty bullets rather than storing blank lines", () => {
    const answer = JSON.stringify({
      sections: [{ sectionId: "key-points", content: ["Real point", "", "   "] }],
    });
    expect(parse(answer).sections[1]!.content).toEqual(["Real point"]);
  });

  it("treats a single string as a one-item content array", () => {
    const answer = JSON.stringify({ sections: [{ sectionId: "overview", content: "One line." }] });
    expect(parse(answer).sections[0]!.content).toEqual(["One line."]);
  });

  it("reads the suggested meeting title out of the envelope", () => {
    expect(parse(WELL_FORMED_ANSWER).title).toBe(SUGGESTED_TITLE);
  });

  it("keeps the title in the language the model answered in", () => {
    const answer = JSON.stringify({
      title: "Releasetermin und offene Aufgaben",
      sections: [{ sectionId: "overview", content: ["Das Team hat sich geeinigt."] }],
    });
    expect(parse(answer).title).toBe("Releasetermin und offene Aufgaben");
  });

  it("has no title when the model offered none, which is not a parse failure", () => {
    const answer = JSON.stringify({
      sections: [{ sectionId: "overview", content: ["It happened."] }],
    });
    const parsed = parse(answer);
    expect(parsed.title).toBeNull();
    expect(parsed.sections[0]!.content).toEqual(["It happened."]);
  });

  it("has no title when the answer skipped the envelope altogether", () => {
    expect(
      parse(JSON.stringify([{ sectionId: "overview", content: ["It happened."] }])).title,
    ).toBeNull();
  });
});

describe("malformed output", () => {
  it("rejects an answer with no JSON in it", () => {
    expect(() => parse("I am afraid I cannot help with that.")).toThrow(SummaryParseError);
  });

  it("names truncation explicitly, which is the usual max_tokens failure", () => {
    expect(() => parse('{"sections":[{"sectionId":"overview","content":["it was cut off')).toThrow(
      /truncated/,
    );
  });

  it("rejects JSON that is malformed rather than merely cut short", () => {
    expect(() => parse('{"sections": [oops,]}')).toThrow(/not valid JSON/);
  });

  it("rejects an answer that names none of the requested sections", () => {
    const answer = JSON.stringify({ sections: [{ sectionId: "something-else", content: ["x"] }] });
    expect(() => parse(answer)).toThrow(/none of the requested section ids/);
  });

  it("extracts the object even when the model chatters around it", () => {
    expect(extractJsonObject('Here: {"a":1} — enjoy!')).toBe('{"a":1}');
  });
});

describe("summary mapping", () => {
  function map() {
    return mapToSummary({
      jobId: SUMMARIZE_JOB_ID,
      meetingId: MEETING_ID,
      transcriptId: TRANSCRIPT_ID,
      templateId: SYSTEM_SUMMARY_TEMPLATE.id,
      templateVersion: SYSTEM_SUMMARY_TEMPLATE.version,
      resolvedSections: SECTIONS,
      options: SYSTEM_SUMMARY_TEMPLATE.options,
      sections: parse(WELL_FORMED_ANSWER).sections,
      model: "test/model",
      promptVersion: PROMPT_VERSION,
      generatedTitle: parse(WELL_FORMED_ANSWER).title,
      createdAt: "2026-08-29T11:05:00.000Z",
    });
  }

  it("produces a summary the shared schema accepts", () => {
    expect(() => SummarySchema.parse(map())).not.toThrow();
  });

  it("derives the id from the job, so a replay maps to the same summary", () => {
    expect(map().id).toBe(summaryIdForJob(SUMMARIZE_JOB_ID));
    expect(map()).toEqual(map());
  });

  it("snapshots the resolved template rather than referencing it (ADR-004)", () => {
    const snapshot = map().templateSnapshot;
    expect(snapshot.templateId).toBe(SYSTEM_SUMMARY_TEMPLATE.id);
    expect(snapshot.templateVersion).toBe(SYSTEM_SUMMARY_TEMPLATE.version);
    expect(snapshot.resolvedSections).toEqual(SECTIONS);
    expect(snapshot.options).toEqual(SYSTEM_SUMMARY_TEMPLATE.options);
    // The snapshot is a copy: editing the template later cannot reach it.
    expect(snapshot.resolvedSections).not.toBe(SYSTEM_SUMMARY_TEMPLATE.sections);
  });

  it("records the model and prompt version that produced it (ADR-005 §3)", () => {
    expect(map()).toMatchObject({ model: "test/model", promptVersion: PROMPT_VERSION });
  });

  it("keeps the transcript it was derived from", () => {
    expect(map().transcriptId).toBe(TRANSCRIPT_ID);
  });

  it("records the suggested title, whether or not the meeting takes it", () => {
    expect(map().generatedTitle).toBe(SUGGESTED_TITLE);
  });

  it("rejects content that violates the summary schema", () => {
    expect(() =>
      mapToSummary({
        jobId: SUMMARIZE_JOB_ID,
        meetingId: "not-a-uuid",
        transcriptId: TRANSCRIPT_ID,
        templateId: SYSTEM_SUMMARY_TEMPLATE.id,
        templateVersion: SYSTEM_SUMMARY_TEMPLATE.version,
        resolvedSections: SECTIONS,
        options: SYSTEM_SUMMARY_TEMPLATE.options,
        sections: [],
        model: "test/model",
        promptVersion: PROMPT_VERSION,
        generatedTitle: null,
        createdAt: "2026-08-29T11:05:00.000Z",
      }),
    ).toThrow(/mapped summary is invalid/);
  });
});
