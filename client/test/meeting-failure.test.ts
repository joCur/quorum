import { describe, expect, it } from "vitest";
import { JOB_ERROR_CODES, type Job, type MeetingDetail } from "@quorum/shared";
import enMessages from "@/i18n/locales/en.json";
import deMessages from "@/i18n/locales/de.json";
import { asJobErrorCode, failedJobId, failureMessageKey } from "@/features/meetings/failure";

/** Reads a dotted i18n key out of a locale bundle. */
function lookup(bundle: unknown, key: string): unknown {
  return key
    .split(".")
    .reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], bundle);
}

const MEETING_ID = "11111111-0000-4000-8000-000000000001";

function job(overrides: Partial<Job>): Job {
  return {
    id: "44444444-0000-4000-8000-000000000001",
    meetingId: MEETING_ID,
    type: "transcribe",
    status: "failed",
    progress: null,
    error: { code: "TRANSCRIPTION_REJECTED", message: "backend answered 404" },
    resultId: null,
    createdAt: "2026-08-29T10:00:00.000Z",
    startedAt: "2026-08-29T10:01:00.000Z",
    finishedAt: "2026-08-29T10:02:00.000Z",
    ...overrides,
  };
}

function detail(jobs: Job[]): MeetingDetail {
  return {
    meeting: { id: MEETING_ID } as MeetingDetail["meeting"],
    transcript: null,
    summaries: [],
    jobs,
  };
}

describe("job failure codes", () => {
  it("recognizes every code the pipeline can report, and nothing else", () => {
    for (const code of JOB_ERROR_CODES) expect(asJobErrorCode(code)).toBe(code);
    expect(asJobErrorCode("UNKNOWN")).toBeNull();
    expect(asJobErrorCode("transcription backend answered 404")).toBeNull();
    expect(asJobErrorCode("")).toBeNull();
    expect(asJobErrorCode(undefined)).toBeNull();
  });

  it("has copy in both languages for every code — a code with no message is a raw string on screen", () => {
    for (const code of JOB_ERROR_CODES) {
      const key = failureMessageKey(code);
      expect(typeof lookup(enMessages, key), `${code} in en`).toBe("string");
      expect(typeof lookup(deMessages, key), `${code} in de`).toBe("string");
    }
  });

  it("falls back to the generic failure for a code this build does not know", () => {
    // A newer pipeline is allowed to report a code this client has never heard of. The one thing
    // that must not happen is the raw string being shown instead.
    expect(failureMessageKey("SOMETHING_NEW")).toBe("meeting.failure.generic");
    expect(failureMessageKey("UNKNOWN")).toBe("meeting.failure.generic");
    expect(typeof lookup(enMessages, "meeting.failure.generic")).toBe("string");
    expect(typeof lookup(deMessages, "meeting.failure.generic")).toBe("string");
  });

  it("says nothing about servers, models or HTTP in any language", () => {
    // The product framing rule: the UI talks about the user's data. A message naming a backend,
    // a model or a status code would be the leak this mapping exists to stop.
    const forbidden = /\b(server|backend|model|modell|HTTP|404|API|endpoint|token)\b/i;
    for (const bundle of [enMessages, deMessages]) {
      const messages = lookup(bundle, "meeting.failure") as Record<string, string>;
      for (const [key, message] of Object.entries(messages)) {
        expect(message, `meeting.failure.${key}`).not.toMatch(forbidden);
      }
    }
  });

  it("finds the failed job of a stage, for the support reference", () => {
    const failed = job({ id: "44444444-0000-4000-8000-00000000000a" });
    const summarize = job({
      id: "44444444-0000-4000-8000-00000000000b",
      type: "summarize",
      status: "failed",
    });

    expect(failedJobId(detail([failed, summarize]), "transcribe")).toBe(failed.id);
    expect(failedJobId(detail([failed, summarize]), "summarize")).toBe(summarize.id);
  });

  it("has no reference to offer when no job row reports the failure", () => {
    // The meeting's state can report a failed stage before its job row is readable, and the panel
    // has to render without a reference rather than inventing one.
    expect(failedJobId(detail([]), "transcribe")).toBeNull();
    expect(failedJobId(detail([job({ status: "succeeded" })]), "transcribe")).toBeNull();
    expect(failedJobId(detail([job({ type: "summarize" })]), "transcribe")).toBeNull();
  });
});
