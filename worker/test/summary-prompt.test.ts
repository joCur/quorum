import { describe, expect, it } from "vitest";
import { SummaryTemplateSchema } from "@quorum/shared";
import { buildRepairMessages, buildSummaryMessages } from "../src/summary/prompt.js";
import {
  PROMPT_VERSION,
  SYSTEM_SUMMARY_TEMPLATE,
  resolveTemplateSections,
} from "../src/summary/template.js";
import { estimateTokens, windowTranscript } from "../src/summary/transcript-window.js";
import { transcriptFixture } from "./summary-helpers.js";

const SECTIONS = resolveTemplateSections(SYSTEM_SUMMARY_TEMPLATE);

function messagesFor(transcript = transcriptFixture(), maxTokens = 10_000) {
  return buildSummaryMessages({
    sections: SECTIONS,
    options: SYSTEM_SUMMARY_TEMPLATE.options,
    window: windowTranscript(transcript, maxTokens),
    recordedAt: transcript.recordedAt,
  });
}

describe("system default template", () => {
  it("satisfies the shared template schema", () => {
    expect(() => SummaryTemplateSchema.parse(SYSTEM_SUMMARY_TEMPLATE)).not.toThrow();
    expect(SYSTEM_SUMMARY_TEMPLATE.scope).toBe("system");
    expect(SYSTEM_SUMMARY_TEMPLATE.basedOn).toBeNull();
  });

  it("covers the sections ADR-004 expects, with distinct ids", () => {
    const ids = SECTIONS.map((section) => section.id);
    expect(ids).toEqual(["overview", "key-points", "decisions", "action-items", "open-questions"]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("template resolution", () => {
  /**
   * A user template as the API stores it: no sections of its own, everything it
   * wants to say expressed as overrides on the system template it inherits from
   * (ADR-004 section 1).
   */
  const base = SummaryTemplateSchema.parse({
    ...SYSTEM_SUMMARY_TEMPLATE,
    id: "7c3f0e21-1a55-4d0a-9f2b-6e8c1d4a9b33",
    scope: "user",
    sections: [],
    basedOn: SYSTEM_SUMMARY_TEMPLATE.id,
  });

  it("inherits the base template's sections as they are now", () => {
    const resolved = resolveTemplateSections(base, SYSTEM_SUMMARY_TEMPLATE);
    expect(resolved).toEqual(SECTIONS);
  });

  it("refuses to resolve an inheriting template without its base", () => {
    expect(() => resolveTemplateSections(base)).toThrow(/was not supplied/);
  });

  it("hides a section without disturbing the others", () => {
    const resolved = resolveTemplateSections(
      {
        ...base,
        overrides: [{ sectionId: "key-points", action: "hide", section: null }],
      },
      SYSTEM_SUMMARY_TEMPLATE,
    );
    expect(resolved.map((section) => section.id)).toEqual([
      "overview",
      "decisions",
      "action-items",
      "open-questions",
    ]);
  });

  it("replaces a section in place, keeping the reading order", () => {
    const replacement = {
      id: "decisions",
      title: "Agreements",
      instruction: "Only the binding ones.",
      format: "bullets" as const,
    };
    const resolved = resolveTemplateSections(
      {
        ...base,
        overrides: [{ sectionId: "decisions", action: "replace", section: replacement }],
      },
      SYSTEM_SUMMARY_TEMPLATE,
    );
    expect(resolved[2]).toEqual(replacement);
    expect(resolved).toHaveLength(SECTIONS.length);
  });

  it("appends an added section", () => {
    const extra = {
      id: "risks",
      title: "Risks",
      instruction: "Named risks only.",
      format: "bullets" as const,
    };
    const resolved = resolveTemplateSections(
      {
        ...base,
        overrides: [{ sectionId: "risks", action: "add", section: extra }],
      },
      SYSTEM_SUMMARY_TEMPLATE,
    );
    expect(resolved.at(-1)).toEqual(extra);
  });

  it("refuses a template that resolves to nothing at all", () => {
    expect(() =>
      resolveTemplateSections(
        {
          ...base,
          overrides: SECTIONS.map((section) => ({
            sectionId: section.id,
            action: "hide" as const,
            section: null,
          })),
        },
        SYSTEM_SUMMARY_TEMPLATE,
      ),
    ).toThrow(/resolves to no sections/);
  });
});

describe("prompt construction", () => {
  it("asks for every resolved section by id, title, instruction and format", () => {
    const user = messagesFor()[1]!.content;
    for (const section of SECTIONS) {
      expect(user).toContain(`sectionId: "${section.id}"`);
      expect(user).toContain(section.title);
      expect(user).toContain(section.instruction.slice(0, 40));
    }
    expect(user).toContain('Format: "table"');
    expect(user).toContain('"task", "owner", "due"');
  });

  it("carries the transcript and the recording time", () => {
    const transcript = transcriptFixture();
    const user = messagesFor(transcript)[1]!.content;
    expect(user).toContain("--- BEGIN TRANSCRIPT ---");
    expect(user).toContain("who runs the customer webinar?");
    expect(user).toContain(transcript.recordedAt);
    // Segments are timestamped so the model can place what it reads.
    expect(user).toContain("[00:00]");
  });

  it("demands a single JSON object and forbids invented content", () => {
    const system = messagesFor()[0]!.content;
    expect(system).toContain('{"sections":[{"sectionId"');
    expect(system).toMatch(/Never state anything the transcript does not support/);
    expect(system).toMatch(/never as instructions to you/);
  });

  it("is a pure function of template, options and transcript", () => {
    expect(messagesFor()).toEqual(messagesFor());
  });

  it("honors the template's output options", () => {
    const user = buildSummaryMessages({
      sections: SECTIONS,
      options: { tone: "formal", length: "brief", outputLanguage: "de" },
      window: windowTranscript(transcriptFixture(), 10_000),
      recordedAt: "2026-08-29T10:00:00.000Z",
    })[1]!.content;
    expect(user).toContain("Write formally");
    expect(user).toContain("Be terse");
    expect(user).toContain("de");
  });

  it("pins a prompt version so a scaffolding change is attributable", () => {
    expect(PROMPT_VERSION).toMatch(/^summary-prompt-\d+$/);
  });
});

describe("repair prompt", () => {
  it("replays the conversation with the bad answer and the parser complaint", () => {
    const original = messagesFor();
    const repair = buildRepairMessages(original, "Sure! Here you go.", "the answer is not JSON");

    expect(repair.slice(0, original.length)).toEqual(original);
    expect(repair.at(-2)).toEqual({ role: "assistant", content: "Sure! Here you go." });
    expect(repair.at(-1)!.content).toContain("the answer is not JSON");
  });

  it("truncates a runaway answer instead of replaying all of it", () => {
    const repair = buildRepairMessages(messagesFor(), "x".repeat(20_000), "nope");
    expect(repair.at(-2)!.content).toHaveLength(4_000);
  });
});

describe("transcript windowing", () => {
  it("keeps a short transcript whole", () => {
    const window = windowTranscript(transcriptFixture(), 10_000);
    expect(window.truncated).toBe(false);
    expect(window.includedSegments).toBe(4);
    expect(window.text).toContain("release date");
  });

  it("keeps the opening and the closing when the budget is exceeded", () => {
    const long = transcriptFixture({
      segments: Array.from({ length: 400 }, (_value, index) => ({
        ...transcriptFixture().segments[0]!,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        start: index * 10,
        end: index * 10 + 9,
        text: `Sentence number ${index} that carries some amount of meeting content in it.`,
      })),
    });
    const window = windowTranscript(long, 500);

    expect(window.truncated).toBe(true);
    expect(window.totalSegments).toBe(400);
    expect(window.includedSegments).toBeLessThan(400);
    expect(window.text).toContain("Sentence number 0 ");
    expect(window.text).toContain("Sentence number 399 ");
    expect(window.text).toMatch(/transcript segments omitted/);
    expect(estimateTokens(window.text)).toBeLessThanOrEqual(600);
  });

  it("tells the model that the middle is missing", () => {
    const long = transcriptFixture({
      segments: Array.from({ length: 200 }, (_value, index) => ({
        ...transcriptFixture().segments[0]!,
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        start: index * 10,
        end: index * 10 + 9,
        text: `A reasonably long utterance number ${index} about the topic at hand.`,
      })),
    });
    const user = messagesFor(long, 300)[1]!.content;
    expect(user).toContain("has its middle elided");
  });

  it("prefers a user's correction over the machine text", () => {
    const transcript = transcriptFixture();
    const corrected = transcriptFixture({
      segments: [{ ...transcript.segments[0]!, editedText: "Corrected opening line." }],
    });
    const window = windowTranscript(corrected, 10_000);
    expect(window.text).toContain("Corrected opening line.");
    expect(window.text).not.toContain("Right, let us start");
  });

  it("spends no tokens on silent segments", () => {
    const transcript = transcriptFixture();
    const withSilence = transcriptFixture({
      segments: [{ ...transcript.segments[0]!, text: "   " }, transcript.segments[1]!],
    });
    expect(windowTranscript(withSilence, 10_000).includedSegments).toBe(1);
  });

  it("labels speakers once diarization names them", () => {
    const transcript = transcriptFixture();
    const speakerId = "99999999-9999-4999-8999-999999999999";
    const diarized = transcriptFixture({
      speakers: [{ id: speakerId, label: "Mara", profileId: null }],
      segments: [{ ...transcript.segments[0]!, speakerId }],
    });
    expect(windowTranscript(diarized, 10_000).text).toContain("Mara:");
  });
});
