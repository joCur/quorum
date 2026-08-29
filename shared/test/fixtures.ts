/**
 * Minimal valid fixtures for the shared schemas.
 * Kept free of optional fields so that defaults are exercised by the round-trip tests.
 */

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const UUID_D = "44444444-4444-4444-8444-444444444444";

const NOW = "2026-08-29T10:00:00.000Z";

export const ids = { UUID_A, UUID_B, UUID_C, UUID_D, NOW };

export const validTranscript = {
  id: UUID_A,
  meetingId: UUID_B,
  schemaVersion: 1,
  isActive: true,
  model: "whisper",
  modelVersion: "large-v3",
  language: "en-US",
  recordedAt: NOW,
  createdAt: NOW,
  segments: [
    {
      id: UUID_C,
      start: 0,
      end: 2.5,
      text: "Welcome everyone.",
    },
  ],
};

export const validSummaryTemplate = {
  id: UUID_A,
  schemaVersion: 1,
  name: "Default meeting notes",
  version: 1,
  scope: "system",
  sections: [
    {
      id: "decisions",
      title: "Decisions",
      instruction: "List every decision the group agreed on.",
      format: "bullets",
    },
  ],
};

export const validSummary = {
  id: UUID_A,
  meetingId: UUID_B,
  transcriptId: UUID_C,
  schemaVersion: 1,
  isActive: true,
  templateSnapshot: {
    templateId: UUID_D,
    templateVersion: 1,
    resolvedSections: [
      {
        id: "decisions",
        title: "Decisions",
        instruction: "List every decision the group agreed on.",
        format: "bullets",
      },
    ],
    options: {
      tone: "neutral",
      length: "standard",
      outputLanguage: "auto",
    },
  },
  model: "gpt-oss",
  promptVersion: "v1",
  createdAt: NOW,
  sections: [
    {
      sectionId: "decisions",
      title: "Decisions",
      format: "bullets",
      content: ["Ship the walking skeleton first."],
    },
  ],
};

export const validJob = {
  id: UUID_A,
  meetingId: UUID_B,
  type: "transcribe",
  status: "queued",
  createdAt: NOW,
};

export const validSessionStart = {
  type: "session.start",
  audioFormat: {
    codec: "opus",
    container: "webm",
    sampleRate: 48000,
    channels: 1,
  },
  clientInfo: {
    platform: "web-desktop",
    userAgent: "vitest",
  },
};

export const validChunkAck = {
  type: "chunk.ack",
  sessionId: UUID_A,
  persistedSeq: 41,
};

export const validChunkMeta = {
  sessionId: UUID_A,
  seq: 7,
  timestampOffset: 12.5,
};
