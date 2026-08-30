import { RecordingIndicator } from "@quorum/client";

const stage: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 72,
  padding: 16,
};

export function ActiveQuiet() {
  return (
    <div style={stage}>
      <RecordingIndicator active level={0.08} />
    </div>
  );
}

export function ActiveSpeaking() {
  return (
    <div style={stage}>
      <RecordingIndicator active level={0.82} />
    </div>
  );
}

export function Paused() {
  return (
    <div style={stage}>
      <RecordingIndicator active={false} level={0} />
    </div>
  );
}
