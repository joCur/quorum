import { LevelMeter } from "@quorum/client";

const stage: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: 10,
  width: 320,
  minHeight: 64,
  padding: 16,
};

const caption: React.CSSProperties = {
  fontSize: 12,
  letterSpacing: "0.06em",
  opacity: 0.65,
};

export function Silent() {
  return (
    <div style={stage}>
      <LevelMeter level={0.02} active />
      <span style={caption}>2% — room tone</span>
    </div>
  );
}

export function Speaking() {
  return (
    <div style={stage}>
      <LevelMeter level={0.45} active />
      <span style={caption}>45% — one voice</span>
    </div>
  );
}

export function Loud() {
  return (
    <div style={stage}>
      <LevelMeter level={0.92} active />
      <span style={caption}>92% — near clipping</span>
    </div>
  );
}

export function Inactive() {
  return (
    <div style={stage}>
      <LevelMeter level={0.7} active={false} />
      <span style={caption}>Paused — meter reads zero</span>
    </div>
  );
}
