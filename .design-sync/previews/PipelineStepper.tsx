import { PipelineStepper } from "@quorum/client";
import type { Meeting, MeetingDetail } from "@quorum/shared";

const AUDIO = { codec: "opus", container: "webm", sampleRate: 48000, channels: 1 };

const meeting: Meeting = {
  id: "0f2a7c1e-6b3d-4f81-9a52-1c8e4b7d0a31",
  sessionId: "5d9b3a44-2f17-4c60-b8e1-77a0c5e2f913",
  title: "Weekly Product Sync",
  status: "transcribing",
  audioFormat: AUDIO,
  createdAt: "2026-08-27T09:00:00.000Z",
  finalizedAt: "2026-08-27T09:45:32.000Z",
  durationSeconds: 2732,
  language: "en-US",
  progress: 0.42,
  hasAudio: true,
  failure: null,
};

const detail = (over: Partial<Meeting>): MeetingDetail => ({
  meeting: { ...meeting, ...over },
  transcript: null,
  summaries: [],
  jobs: [],
});

const frame: React.CSSProperties = { maxWidth: 560 };

export function Transcribing() {
  return (
    <div style={frame}>
      <PipelineStepper detail={detail({ status: "transcribing", progress: 0.42 })} />
    </div>
  );
}

export function Queued() {
  return (
    <div style={frame}>
      <PipelineStepper detail={detail({ status: "queued", progress: null })} />
    </div>
  );
}

export function Summarizing() {
  return (
    <div style={frame}>
      <PipelineStepper detail={detail({ status: "summarizing", progress: null })} />
    </div>
  );
}

export function Done() {
  return (
    <div style={frame}>
      <PipelineStepper detail={detail({ status: "ready", progress: null })} />
    </div>
  );
}

export function FailedSummary() {
  return (
    <div style={frame}>
      <PipelineStepper
        detail={detail({
          status: "failed",
          progress: null,
          failure: {
            stage: "summarize",
            code: "MODEL_TIMEOUT",
            message: "The summary model did not respond in time.",
          },
        })}
      />
    </div>
  );
}
