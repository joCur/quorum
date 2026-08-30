import { StatusBadge } from "@quorum/client";

const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" };

export function AllStatuses() {
  return (
    <div style={row}>
      <StatusBadge status="recording" />
      <StatusBadge status="queued" />
      <StatusBadge status="transcribing" />
      <StatusBadge status="summarizing" />
      <StatusBadge status="ready" />
      <StatusBadge status="failed" />
    </div>
  );
}
