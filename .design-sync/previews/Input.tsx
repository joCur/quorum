import { Input } from "@quorum/client";

const stack: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 12,
  maxWidth: 420,
};

export function Default() {
  return (
    <div style={stack}>
      <Input defaultValue="Quarterly roadmap review" />
    </div>
  );
}

export function Placeholder() {
  return (
    <div style={stack}>
      <Input placeholder="Search meetings and transcripts" />
      <Input type="email" placeholder="you@company.com" />
    </div>
  );
}

export function States() {
  return (
    <div style={stack}>
      <Input defaultValue="Weekly engineering standup" />
      <Input disabled defaultValue="Recording in progress — title locked" />
      <Input readOnly defaultValue="https://quorum.app/s/9f3ka2-summary" />
    </div>
  );
}
