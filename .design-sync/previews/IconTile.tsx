import { IconTile } from "@quorum/client";
import { FileText, Mic, ListChecks, Sparkles } from "lucide-react";

export function LargeHoney() {
  return <IconTile icon={Mic} accent="honey" size="lg" />;
}

export function LargePlum() {
  return <IconTile icon={Sparkles} accent="plum" size="lg" />;
}

export function SmallPair() {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
      <IconTile icon={FileText} accent="honey" size="sm" />
      <IconTile icon={ListChecks} accent="plum" size="sm" />
    </div>
  );
}
