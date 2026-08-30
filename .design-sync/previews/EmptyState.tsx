import { Button, EmptyState } from "@quorum/client";
import { Mic, Search } from "lucide-react";

export function NoMeetingsYet() {
  return (
    <EmptyState
      icon={Mic}
      accent="honey"
      title="No meetings yet"
      body="Record your first meeting and Quorum will keep the audio, the transcript and a short summary in one place."
    >
      <Button>Start recording</Button>
    </EmptyState>
  );
}

export function NoSearchResults() {
  return (
    <EmptyState
      icon={Search}
      accent="plum"
      title="No meetings match “retention”"
      body="Try a shorter phrase, or search for a participant instead of a topic."
    />
  );
}
