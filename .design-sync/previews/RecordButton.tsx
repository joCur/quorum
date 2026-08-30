import { RecordButton } from "@quorum/client";

const noop = () => undefined;

const stage: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  minHeight: 140,
  padding: 16,
};

export function Idle() {
  return (
    <div style={stage}>
      <RecordButton phase="idle" onStart={noop} onStop={noop} onResume={noop} />
    </div>
  );
}

export function Starting() {
  return (
    <div style={stage}>
      <RecordButton phase="requesting" onStart={noop} onStop={noop} onResume={noop} />
    </div>
  );
}

export function Recording() {
  return (
    <div style={stage}>
      <RecordButton phase="recording" onStart={noop} onStop={noop} onResume={noop} />
    </div>
  );
}

export function Paused() {
  return (
    <div style={stage}>
      <RecordButton phase="paused" onStart={noop} onStop={noop} onResume={noop} />
    </div>
  );
}

export function Finalizing() {
  return (
    <div style={stage}>
      <RecordButton phase="finalizing" onStart={noop} onStop={noop} onResume={noop} />
    </div>
  );
}
