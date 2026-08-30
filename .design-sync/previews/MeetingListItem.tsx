import { MeetingListItem } from "@quorum/client";
import type { Meeting } from "@quorum/shared";

const base: Meeting = {
  id: "0f2a7c1e-6b3d-4f81-9a52-1c8e4b7d0a31",
  sessionId: "5d9b3a44-2f17-4c60-b8e1-77a0c5e2f913",
  title: "Weekly Product Sync",
  status: "ready",
  audioFormat: { codec: "opus", container: "webm", sampleRate: 48000, channels: 1 },
  createdAt: "2026-08-27T09:00:00.000Z",
  finalizedAt: "2026-08-27T09:45:32.000Z",
  durationSeconds: 2732,
  language: "en-US",
  progress: null,
  hasAudio: true,
  failure: null,
};

const meeting = (over: Partial<Meeting>, id: string): Meeting => ({ ...base, ...over, id });

const frame: React.CSSProperties = { maxWidth: 720 };
const noop = (): void => undefined;

export function Ready() {
  return (
    <div style={frame}>
      <MeetingListItem meeting={base} index={0} deleting={false} onDelete={noop} />
    </div>
  );
}

export function Transcribing() {
  return (
    <div style={frame}>
      <MeetingListItem
        meeting={meeting(
          {
            title: "Design Review — Onboarding Flow",
            status: "transcribing",
            createdAt: "2026-08-30T13:15:00.000Z",
            finalizedAt: "2026-08-30T13:52:10.000Z",
            durationSeconds: null,
            language: null,
            progress: 0.42,
          },
          "b41c9d28-0e57-4a13-8f6b-2d90a7c51e64",
        )}
        index={1}
        deleting={false}
        onDelete={noop}
      />
    </div>
  );
}

export function Failed() {
  return (
    <div style={frame}>
      <MeetingListItem
        meeting={meeting(
          {
            title: "Platform Standup",
            status: "failed",
            createdAt: "2026-08-26T08:30:00.000Z",
            durationSeconds: 611,
            failure: {
              stage: "summarize",
              code: "MODEL_TIMEOUT",
              message: "The summary model did not respond in time.",
            },
          },
          "7c30e6b9-4a82-4d15-91cf-6b23e07a58d2",
        )}
        index={2}
        deleting={false}
        onDelete={noop}
      />
    </div>
  );
}

export function Untitled() {
  return (
    <div style={frame}>
      <MeetingListItem
        meeting={meeting(
          { title: null, createdAt: "2026-08-25T16:05:00.000Z", durationSeconds: 184 },
          "1e5f8a70-93c4-4b26-a0d8-5f41cb98e207",
        )}
        index={3}
        deleting={false}
        onDelete={noop}
      />
    </div>
  );
}

export function Deleting() {
  return (
    <div style={frame}>
      <MeetingListItem
        meeting={meeting(
          { title: "Roadmap Planning Q4", createdAt: "2026-08-24T11:00:00.000Z" },
          "9a6d2b58-71ef-4c03-bd94-380a6e15c7f2",
        )}
        index={4}
        deleting
        onDelete={noop}
      />
    </div>
  );
}
