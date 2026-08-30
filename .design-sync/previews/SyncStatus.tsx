import { SyncStatus } from "@quorum/client";

const stage: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 420,
  minHeight: 56,
  padding: 12,
};

const base = {
  sessionId: "b1f4c0d2-9e6a-4f3b-8c15-2a7d5e9f0c31",
  lastSeq: 212,
  persistedSeq: 212,
  pendingChunks: 0,
  pendingSeconds: 0,
  finalized: false,
};

export function SavingBacklog() {
  return (
    <div style={stage}>
      <SyncStatus
        status={{ ...base, connection: "open", persistedSeq: 200, pendingChunks: 12, pendingSeconds: 12.4 }}
      />
    </div>
  );
}

export function ConnectionUnstable() {
  return (
    <div style={stage}>
      <SyncStatus
        status={{
          ...base,
          connection: "reconnecting",
          persistedSeq: 178,
          pendingChunks: 34,
          pendingSeconds: 34.1,
        }}
      />
    </div>
  );
}

export function Silent() {
  return (
    <div style={stage}>
      <SyncStatus status={{ ...base, connection: "open" }} />
    </div>
  );
}
