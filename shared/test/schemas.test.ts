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
  SUMMARY_SCHEMA_VERSION,
  TRANSCRIPT_SCHEMA_VERSION,
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
