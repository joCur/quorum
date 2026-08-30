import { ConnectionBanner } from "@quorum/client";

const stage: React.CSSProperties = { width: 560, padding: 12 };

const base = {
  sessionId: "b1f4c0d2-9e6a-4f3b-8c15-2a7d5e9f0c31",
  lastSeq: 184,
  persistedSeq: 184,
  pendingChunks: 0,
  pendingSeconds: 0,
  finalized: false,
};

export function Offline() {
  return (
    <div style={stage}>
      <ConnectionBanner
        status={{
          ...base,
          connection: "closed",
          persistedSeq: 161,
          pendingChunks: 23,
          pendingSeconds: 23.4,
        }}
        storageLow={false}
      />
    </div>
  );
}

export function Reconnecting() {
  return (
    <div style={stage}>
      <ConnectionBanner
        status={{
          ...base,
          connection: "reconnecting",
          persistedSeq: 176,
          pendingChunks: 8,
          pendingSeconds: 8.2,
        }}
        storageLow={false}
      />
    </div>
  );
}

export function StorageLow() {
  return (
    <div style={stage}>
      <ConnectionBanner
        status={{ ...base, connection: "reconnecting", pendingChunks: 142, pendingSeconds: 142.7 }}
        storageLow
      />
    </div>
  );
}
