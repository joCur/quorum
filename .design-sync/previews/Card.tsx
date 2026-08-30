import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@quorum/client";

export function SummarySection() {
  return (
    <Card style={{ maxWidth: 420 }}>
      <CardHeader>
        <CardTitle>Weekly product sync</CardTitle>
        <CardDescription>Aug 28, 2026 · 42 min · 5 participants</CardDescription>
      </CardHeader>
      <CardContent>
        <p style={{ margin: 0 }}>
          The team agreed to ship the recording flow behind a feature flag and to move the
          transcript review to next sprint. Open question: retention window for raw audio.
        </p>
      </CardContent>
      <CardFooter style={{ gap: 8 }}>
        <Button size="sm">Open summary</Button>
        <Button size="sm" variant="ghost">
          Share
        </Button>
      </CardFooter>
    </Card>
  );
}

export function SettingsGroup() {
  return (
    <Card style={{ maxWidth: 420 }}>
      <CardHeader>
        <CardTitle>Language</CardTitle>
        <CardDescription>Transcripts and summaries follow the meeting language.</CardDescription>
      </CardHeader>
      <CardContent>
        <p style={{ margin: 0 }}>Detected automatically per meeting.</p>
      </CardContent>
    </Card>
  );
}
