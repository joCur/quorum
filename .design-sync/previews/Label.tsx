import { Input, Label } from "@quorum/client";

const field: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 8,
  maxWidth: 420,
};

export function WithInput() {
  return (
    <div style={field}>
      <Label htmlFor="meeting-title">Meeting title</Label>
      <Input id="meeting-title" defaultValue="Quarterly roadmap review" />
    </div>
  );
}

export function FieldGroup() {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20, maxWidth: 420 }}>
      <div style={field}>
        <Label htmlFor="meeting-search">Search meetings</Label>
        <Input id="meeting-search" placeholder="Title, participant or keyword" />
      </div>
      <div style={field}>
        <Label htmlFor="participants">Participants</Label>
        <Input id="participants" defaultValue="Dana Whitfield, Miguel Ortiz, Priya Raman" />
        <span style={{ fontSize: 13, opacity: 0.7 }}>
          Separate names with commas. Used to label speakers in the transcript.
        </span>
      </div>
    </div>
  );
}

export function DisabledField() {
  return (
    <div style={field}>
      <Label htmlFor="workspace">Workspace</Label>
      <Input id="workspace" disabled defaultValue="Northwind Product Team" />
    </div>
  );
}
