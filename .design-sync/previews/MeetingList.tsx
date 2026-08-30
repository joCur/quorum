import { MeetingList, MeetingsOnboarding } from "@quorum/client";
import type { Meeting } from "@quorum/shared";

const AUDIO = { codec: "opus", container: "webm", sampleRate: 48000, channels: 1 };

const meetings: Meeting[] = [
  {
    id: "0f2a7c1e-6b3d-4f81-9a52-1c8e4b7d0a31",
    sessionId: "5d9b3a44-2f17-4c60-b8e1-77a0c5e2f913",
    title: "Weekly Product Sync",
    status: "ready",
    audioFormat: AUDIO,
    createdAt: "2026-08-27T09:00:00.000Z",
    finalizedAt: "2026-08-27T09:45:32.000Z",
    durationSeconds: 2732,
    language: "en-US",
    progress: null,
    hasAudio: true,
    failure: null,
  },
  {
    id: "b41c9d28-0e57-4a13-8f6b-2d90a7c51e64",
    sessionId: "c8e10a37-52bd-4f96-8a41-e0d73b5c1962",
    title: "Design Review — Onboarding Flow",
    status: "transcribing",
    audioFormat: AUDIO,
    createdAt: "2026-08-30T13:15:00.000Z",
    finalizedAt: "2026-08-30T13:52:10.000Z",
    durationSeconds: null,
    language: null,
    progress: 0.42,
    hasAudio: true,
    failure: null,
  },
  {
    id: "7c30e6b9-4a82-4d15-91cf-6b23e07a58d2",
    sessionId: "2a94f0d6-8c31-4b07-95e2-6f18d3a7c045",
    title: "Platform Standup",
    status: "failed",
    audioFormat: AUDIO,
    createdAt: "2026-08-26T08:30:00.000Z",
    finalizedAt: "2026-08-26T08:40:11.000Z",
    durationSeconds: 611,
    language: "en-US",
    progress: null,
    hasAudio: true,
    failure: {
      stage: "summarize",
      code: "MODEL_TIMEOUT",
      message: "The summary model did not respond in time.",
    },
  },
  {
    id: "1e5f8a70-93c4-4b26-a0d8-5f41cb98e207",
    sessionId: "6d02b8e5-14fa-4c73-8019-b4c65e9d2371",
    title: null,
    status: "summarizing",
    audioFormat: AUDIO,
    createdAt: "2026-08-25T16:05:00.000Z",
    finalizedAt: "2026-08-25T16:08:04.000Z",
    durationSeconds: 184,
    language: "en-US",
    progress: null,
    hasAudio: true,
    failure: null,
  },
];

const noop = (): void => undefined;
const removeNoop = (): Promise<void> => Promise.resolve();

const listOf = (over: Partial<Parameters<typeof MeetingList>[0]["list"]>) => ({
  meetings,
  status: "ready" as const,
  errorCode: null,
  deleting: new Set<string>(),
  reload: noop,
  remove: removeNoop,
  ...over,
});

const frame: React.CSSProperties = { maxWidth: 720 };

export function Populated() {
  return (
    <div style={frame}>
      <MeetingList
        list={listOf({})}
        searching={false}
        onClearSearch={noop}
        onboarding={<MeetingsOnboarding />}
      />
    </div>
  );
}

export function WithDeletionInFlight() {
  return (
    <div style={frame}>
      <MeetingList
        list={listOf({ deleting: new Set(["7c30e6b9-4a82-4d15-91cf-6b23e07a58d2"]) })}
        searching={false}
        onClearSearch={noop}
        onboarding={<MeetingsOnboarding />}
      />
    </div>
  );
}

export function Loading() {
  return (
    <div style={frame}>
      <MeetingList
        list={listOf({ status: "loading", meetings: [] })}
        searching={false}
        onClearSearch={noop}
        onboarding={<MeetingsOnboarding />}
      />
    </div>
  );
}

export function NoSearchResults() {
  return (
    <div style={frame}>
      <MeetingList
        list={listOf({ meetings: [] })}
        searching
        onClearSearch={noop}
        onboarding={<MeetingsOnboarding />}
      />
    </div>
  );
}

export function LoadError() {
  return (
    <div style={frame}>
      <MeetingList
        list={listOf({ status: "error", meetings: [], errorCode: "UPSTREAM_UNAVAILABLE" })}
        searching={false}
        onClearSearch={noop}
        onboarding={<MeetingsOnboarding />}
      />
    </div>
  );
}

export function FirstRun() {
  return (
    <div style={frame}>
      <MeetingList
        list={listOf({ meetings: [] })}
        searching={false}
        onClearSearch={noop}
        onboarding={<MeetingsOnboarding />}
      />
    </div>
  );
}
