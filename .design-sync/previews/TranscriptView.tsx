import { TranscriptView } from "@quorum/client";
import type { Segment, Transcript, Word } from "@quorum/shared";

const SPEAKERS = [
  { id: "3f1c8b20-4d6e-4a97-b012-5e8a3c74d961", label: "Maya Ellis", profileId: null },
  { id: "8b47e50c-19a3-4f28-9d6b-27c0a5f31e84", label: "Tomás Rivera", profileId: null },
  { id: "c05a9d13-7e64-4b81-a3f2-90d18b6c4275", label: "Priya Nandan", profileId: null },
];

/** Splits a sentence into evenly spaced word timings, the way the transcriber stores them. */
function words(text: string, start: number, end: number): Word[] {
  const parts = text.split(" ");
  const step = (end - start) / parts.length;
  return parts.map((word, index) => ({
    word,
    start: Number((start + index * step).toFixed(2)),
    end: Number((start + (index + 1) * step).toFixed(2)),
  }));
}

function segment(
  id: string,
  speakerId: string,
  start: number,
  end: number,
  text: string,
  over: Partial<Segment> = {},
): Segment {
  return {
    id,
    start,
    end,
    text,
    editedText: null,
    confidence: 0.94,
    speakerId,
    editedSpeakerId: null,
    language: null,
    words: words(text, start, end),
    ...over,
  };
}

const segments: Segment[] = [
  segment(
    "a1d6f204-3c78-4e91-8b52-06f4a9d13c87",
    SPEAKERS[0]!.id,
    0,
    14.2,
    "Alright, let's get started. The agenda today is the onboarding funnel, the export backlog, and then whatever is left over from last week.",
  ),
  segment(
    "e2b7c391-58a0-4d13-9f6c-41ba07d5e298",
    SPEAKERS[1]!.id,
    14.2,
    31.8,
    "On the funnel: the second step is still where people drop off. About a third of the accounts that reach the workspace screen never finish it, and the session recordings suggest they simply do not know what a workspace is for.",
  ),
  segment(
    "5c8e0b47-92da-4f36-b710-8e3d5a29c064",
    SPEAKERS[2]!.id,
    31.8,
    47.5,
    "We could collapse it into the first step and pick a sensible default name. Nobody renames it later anyway, so the screen is mostly asking a question we already know the answer to.",
  ),
  segment(
    "9f14a685-0d27-4c50-83be-72c1e04b8d39",
    SPEAKERS[0]!.id,
    47.5,
    58.9,
    "Let's try that behind a flag for a week and compare completion. Tomás, can you take the instrumentation?",
    { confidence: 0.41, words: null },
  ),
  segment(
    "6d90b2f8-4a15-4e73-9c28-b501d7fa3e46",
    SPEAKERS[1]!.id,
    58.9,
    72.4,
    "Yes. I will keep the old step in the code path so we can roll back without a deploy if the numbers get worse.",
  ),
  segment(
    "2e58d1c0-6b93-4a27-8f41-0c7e5b93a6d2",
    SPEAKERS[2]!.id,
    72.4,
    88.0,
    "One more thing on exports — the CSV job still times out for the largest accounts, and support has had four tickets about it this month.",
    { editedText: "One more thing on exports — the CSV job still times out for our largest accounts, and support has had four tickets about it this month." },
  ),
];

const transcript: Transcript = {
  id: "4b7a1e36-c920-4d58-8137-e6a05f2b94c1",
  meetingId: "0f2a7c1e-6b3d-4f81-9a52-1c8e4b7d0a31",
  schemaVersion: 1,
  isActive: true,
  model: "whisper-large-v3",
  modelVersion: "2026-05-11",
  language: "en-US",
  recordedAt: "2026-08-27T09:00:00.000Z",
  createdAt: "2026-08-27T09:48:02.000Z",
  speakers: SPEAKERS,
  segments,
};

const frame: React.CSSProperties = { maxWidth: 720 };
const noop = (): void => undefined;

export function Playing() {
  return (
    <div style={frame}>
      <TranscriptView transcript={transcript} currentTime={38.4} onSeek={noop} />
    </div>
  );
}

export function AtRest() {
  return (
    <div style={frame}>
      {/* Playhead past the end: nothing is highlighted, which is how the panel sits when idle. */}
      <TranscriptView transcript={transcript} currentTime={9999} onSeek={noop} />
    </div>
  );
}
