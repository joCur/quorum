import { describe, expect, it } from "vitest";
import {
  ChunkMetaSchema,
  ClientMessageSchema,
  JobSchema,
  ServerMessageSchema,
  SummarySchema,
  SummaryTemplateSchema,
  TranscriptSchema,
  CHUNK_HEADER_BYTES,
  JOB_ERROR_CODES,
  SUMMARY_SCHEMA_VERSION,
  TRANSCRIPT_SCHEMA_VERSION,
  isRetryableJobErrorCode,
} from "../src/index.js";
import {
  ids,
  validChunkAck,
  validChunkMeta,
  validJob,
  validSessionStart,
  validSummary,
  validSummaryTemplate,
  validTranscript,
} from "./fixtures.js";

describe("schema constants", () => {
  it("exposes the expected versions and binary header size", () => {
    expect(TRANSCRIPT_SCHEMA_VERSION).toBe(1);
    expect(SUMMARY_SCHEMA_VERSION).toBe(1);
    expect(CHUNK_HEADER_BYTES).toBe(28);
  });
});

describe("TranscriptSchema", () => {
  it("parses a valid transcript and applies defaults", () => {
    const parsed = TranscriptSchema.parse(validTranscript);
    expect(parsed.speakers).toEqual([]);
    expect(parsed.segments[0]?.editedText).toBeNull();
    expect(parsed.segments[0]?.speakerId).toBeNull();
    expect(parsed.segments[0]?.words).toBeNull();
  });

  it("round-trips: parse output re-parses to the same value", () => {
    const once = TranscriptSchema.parse(validTranscript);
    const twice = TranscriptSchema.parse(once);
    expect(twice).toEqual(once);
  });

  it("rejects a wrong schema version", () => {
    expect(TranscriptSchema.safeParse({ ...validTranscript, schemaVersion: 2 }).success).toBe(
      false,
    );
  });

  it("rejects a non-UUID segment id", () => {
    const broken = {
      ...validTranscript,
      segments: [{ ...validTranscript.segments[0], id: "not-a-uuid" }],
    };
    expect(TranscriptSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a negative segment start", () => {
    const broken = {
      ...validTranscript,
      segments: [{ ...validTranscript.segments[0], start: -1 }],
    };
    expect(TranscriptSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a missing required field", () => {
    const { model: _model, ...withoutModel } = validTranscript;
    expect(TranscriptSchema.safeParse(withoutModel).success).toBe(false);
  });
});

describe("SummaryTemplateSchema", () => {
  it("parses a valid template and defaults options and overrides", () => {
    const parsed = SummaryTemplateSchema.parse(validSummaryTemplate);
    expect(parsed.basedOn).toBeNull();
    expect(parsed.overrides).toEqual([]);
    expect(parsed.options).toEqual({
      tone: "neutral",
      length: "standard",
      outputLanguage: "auto",
    });
  });

  it("round-trips", () => {
    const once = SummaryTemplateSchema.parse(validSummaryTemplate);
    expect(SummaryTemplateSchema.parse(once)).toEqual(once);
  });

  it("rejects an unknown section format", () => {
    const broken = {
      ...validSummaryTemplate,
      sections: [{ ...validSummaryTemplate.sections[0], format: "haiku" }],
    };
    expect(SummaryTemplateSchema.safeParse(broken).success).toBe(false);
  });

  it("rejects a non-positive version", () => {
    expect(SummaryTemplateSchema.safeParse({ ...validSummaryTemplate, version: 0 }).success).toBe(
      false,
    );
  });
});

describe("SummarySchema", () => {
  it("parses a valid summary and defaults source segment ids", () => {
    const parsed = SummarySchema.parse(validSummary);
    expect(parsed.sections[0]?.sourceSegmentIds).toBeNull();
  });

  it("round-trips", () => {
    const once = SummarySchema.parse(validSummary);
    expect(SummarySchema.parse(once)).toEqual(once);
  });

  it("rejects a missing template snapshot", () => {
    const { templateSnapshot: _snapshot, ...broken } = validSummary;
    expect(SummarySchema.safeParse(broken).success).toBe(false);
  });
});

describe("JobSchema", () => {
  it("parses a valid job and defaults the optional fields", () => {
    const parsed = JobSchema.parse(validJob);
    expect(parsed.progress).toBeNull();
    expect(parsed.error).toBeNull();
    expect(parsed.resultId).toBeNull();
    expect(parsed.startedAt).toBeNull();
    expect(parsed.finishedAt).toBeNull();
  });

  it("round-trips", () => {
    const once = JobSchema.parse(validJob);
    expect(JobSchema.parse(once)).toEqual(once);
  });

  it("rejects an unknown job type", () => {
    expect(JobSchema.safeParse({ ...validJob, type: "translate" }).success).toBe(false);
  });

  it("rejects progress outside 0..1", () => {
    expect(JobSchema.safeParse({ ...validJob, progress: 1.5 }).success).toBe(false);
  });

  it("rejects a non-ISO createdAt", () => {
    expect(JobSchema.safeParse({ ...validJob, createdAt: "yesterday" }).success).toBe(false);
  });
});

/**
 * Which failures a person may ask to have run again.
 *
 * The rule is what the failure is about: the recording itself never changes, so repeating a job
 * that choked on it cannot end differently — everything around it can and does.
 */
describe("isRetryableJobErrorCode", () => {
  it("refuses the failures that are about the recording or the payload", () => {
    for (const code of [
      "MANIFEST_NOT_FOUND",
      "AUDIO_EMPTY",
      "AUDIO_DECODE_FAILED",
      "AUDIO_TOO_LARGE",
      "JOB_PAYLOAD_INVALID",
      "TRANSCRIPT_INVALID",
      "TRANSCRIPT_NOT_FOUND",
      "TRANSCRIPT_EMPTY",
      "SUMMARY_TEMPLATE_NOT_FOUND",
      "SUMMARY_INVALID",
    ]) {
      expect(isRetryableJobErrorCode(code), code).toBe(false);
    }
  });

  it("allows the failures that are about the machinery around it", () => {
    for (const code of [
      "AUDIO_FETCH_FAILED",
      "TRANSCRIPTION_UNAVAILABLE",
      "TRANSCRIPT_PERSIST_FAILED",
      "SUMMARY_UNAVAILABLE",
      "SUMMARY_PERSIST_FAILED",
      "INTERNAL_ERROR",
    ]) {
      expect(isRetryableJobErrorCode(code), code).toBe(true);
    }
  });

  it("allows the transcription failures that name the backend, not the recording", () => {
    // Deliberately more generous than the per-attempt flags in `worker/src/errors.ts`: these name
    // the backend, and a person asking again is saying the backend has been changed since. The
    // one refusal of that family nobody can fix — audio too large for it — has its own code, so
    // being generous here does not offer anyone a dead end.
    for (const code of ["TRANSCRIPTION_REJECTED", "TRANSCRIPTION_RESPONSE_INVALID"]) {
      expect(isRetryableJobErrorCode(code), code).toBe(true);
    }
  });

  it("answers the summary codes exactly as the pipeline does", () => {
    // No generosity on this side: a summary attempt is a paid call, `SUMMARY_REJECTED` covers an
    // oversized prompt that would buy the same answer twice, and nothing offers a summary retry
    // yet. Deciding it in advance would be guessing at a cost question for a feature that does
    // not exist.
    expect(isRetryableJobErrorCode("SUMMARY_REJECTED")).toBe(false);
    expect(isRetryableJobErrorCode("SUMMARY_RESPONSE_INVALID")).toBe(false);
  });

  it("treats a code it has never heard of as not worth repeating", () => {
    // An older client against a newer pipeline. Offering an action for a failure nobody here can
    // explain would be a guess, and the server would refuse it anyway.
    expect(isRetryableJobErrorCode("SOMETHING_NEW")).toBe(false);
    expect(isRetryableJobErrorCode("")).toBe(false);
  });

  it("has an answer for every code in the contract", () => {
    for (const code of JOB_ERROR_CODES) {
      expect(typeof isRetryableJobErrorCode(code), code).toBe("boolean");
    }
  });
});

describe("recording protocol messages", () => {
  it("parses a client session.start and defaults the meeting title", () => {
    const parsed = ClientMessageSchema.parse(validSessionStart);
    expect(parsed.type).toBe("session.start");
    if (parsed.type === "session.start") {
      expect(parsed.meetingTitle).toBeNull();
    }
  });

  it("round-trips a client message", () => {
    const once = ClientMessageSchema.parse(validSessionStart);
    expect(ClientMessageSchema.parse(once)).toEqual(once);
  });

  it("parses a server chunk.ack and round-trips it", () => {
    const once = ServerMessageSchema.parse(validChunkAck);
    expect(ServerMessageSchema.parse(once)).toEqual(once);
  });

  it("rejects an unknown message type in the discriminated union", () => {
    expect(ClientMessageSchema.safeParse({ type: "session.explode" }).success).toBe(false);
    expect(
      ServerMessageSchema.safeParse({ type: "chunk.nack", sessionId: ids.UUID_A }).success,
    ).toBe(false);
  });

  it("rejects a negative persistedSeq", () => {
    expect(ServerMessageSchema.safeParse({ ...validChunkAck, persistedSeq: -1 }).success).toBe(
      false,
    );
  });

  it("parses and round-trips chunk metadata", () => {
    const once = ChunkMetaSchema.parse(validChunkMeta);
    expect(ChunkMetaSchema.parse(once)).toEqual(once);
  });

  it("rejects a fractional chunk sequence number", () => {
    expect(ChunkMetaSchema.safeParse({ ...validChunkMeta, seq: 1.5 }).success).toBe(false);
  });
});
