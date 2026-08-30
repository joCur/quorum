import { AlertTriangle, CheckCircle2, Circle, Clock, Mic, XCircle } from "lucide-react";
import { Badge } from "@quorum/client";

const row: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  flexWrap: "wrap",
};

export function Variants() {
  return (
    <div style={row}>
      <Badge variant="neutral">Draft</Badge>
      <Badge variant="info">Transcribing</Badge>
      <Badge variant="success">Summary ready</Badge>
      <Badge variant="warning">Retrying</Badge>
      <Badge variant="destructive">Failed</Badge>
      <Badge variant="recording">Recording</Badge>
    </div>
  );
}

export function WithIcons() {
  return (
    <div style={row}>
      <Badge variant="neutral">
        <Circle />
        Queued
      </Badge>
      <Badge variant="info">
        <Clock />
        Transcribing 62%
      </Badge>
      <Badge variant="success">
        <CheckCircle2 />
        Summary ready
      </Badge>
      <Badge variant="warning">
        <AlertTriangle />
        Partial audio
      </Badge>
      <Badge variant="destructive">
        <XCircle />
        Transcription failed
      </Badge>
      <Badge variant="recording">
        <Mic />
        Recording 14:32
      </Badge>
    </div>
  );
}

export function InContext() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, maxWidth: 420 }}>
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
      >
        <span style={{ fontWeight: 600 }}>Quarterly roadmap review</span>
        <Badge variant="success">
          <CheckCircle2 />
          Summary ready
        </Badge>
      </div>
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
      >
        <span style={{ fontWeight: 600 }}>Design sync — recording</span>
        <Badge variant="recording">
          <Mic />
          Recording
        </Badge>
      </div>
      <div
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
      >
        <span style={{ fontWeight: 600 }}>Customer interview: Acme</span>
        <Badge variant="info">
          <Clock />
          Transcribing
        </Badge>
      </div>
    </div>
  );
}
