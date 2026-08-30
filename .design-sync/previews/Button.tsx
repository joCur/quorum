import { Mic, Trash2 } from "lucide-react";
import { Button } from "@quorum/client";

const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" };

export function Variants() {
  return (
    <div style={row}>
      <Button>Save summary</Button>
      <Button variant="secondary">Rename</Button>
      <Button variant="outline">Export</Button>
      <Button variant="ghost">Cancel</Button>
      <Button variant="destructive">Delete meeting</Button>
      <Button variant="link">View transcript</Button>
    </div>
  );
}

export function Sizes() {
  return (
    <div style={row}>
      <Button size="sm">Small</Button>
      <Button>Default</Button>
      <Button size="lg">Large</Button>
      <Button size="icon" aria-label="Start recording">
        <Mic />
      </Button>
    </div>
  );
}

export function States() {
  return (
    <div style={row}>
      <Button disabled>Disabled</Button>
      <Button variant="destructive" disabled>
        <Trash2 />
        Deleting…
      </Button>
    </div>
  );
}
