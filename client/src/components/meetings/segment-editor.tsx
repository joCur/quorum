import * as React from "react";
import { Check, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Segment, SegmentOverlay, Transcript } from "@quorum/shared";
import { Select } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

/**
 * Correcting one segment: what it should say, and who said it (ADR-003 §2).
 *
 * The machine output is shown underneath the field the whole time the editor is open. It is not
 * decoration — it is the promise the feature rests on, that nothing a user types replaces what was
 * transcribed, and reading it while typing is what makes that believable before anyone has tried
 * the reset.
 *
 * Enter saves and Escape restores, like every other inline editor here; Shift+Enter is a line
 * break, because a corrected passage is prose and occasionally needs one. A failed save keeps the
 * editor open with the typed text — the one thing a correction must never do is swallow it.
 */
export function SegmentEditor({
  transcript,
  segment,
  onSave,
  onCancel,
}: {
  transcript: Transcript;
  segment: Segment;
  onSave: (overlay: SegmentOverlay) => Promise<void>;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = React.useState(segment.editedText ?? segment.text);
  const [speakerId, setSpeakerId] = React.useState(segment.editedSpeakerId ?? segment.speakerId);
  const [saving, setSaving] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const save = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setFailed(false);
    try {
      // Both fields go every time: the overlay is stored as sent, so leaving one out would read
      // as "and no override of that kind" (ADR-010 §5).
      await onSave({ editedText: text, editedSpeakerId: speakerId });
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        autoFocus
        value={text}
        disabled={saving}
        aria-label={t("meeting.transcript.correction.label")}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            void save();
          }
          if (event.key === "Escape") onCancel();
        }}
      />

      {/*
        The speaker picker exists only for a transcript that knows any speakers. Diarization is
        not in the pipeline yet, so for most transcripts this is nothing to offer rather than a
        control standing there with one useless option in it.
      */}
      {transcript.speakers.length > 0 ? (
        <Select
          value={speakerId ?? ""}
          disabled={saving}
          aria-label={t("meeting.transcript.correction.speaker")}
          onChange={(event) => setSpeakerId(event.target.value === "" ? null : event.target.value)}
        >
          <option value="">{t("meeting.transcript.correction.speakerNone")}</option>
          {transcript.speakers.map((speaker) => (
            <option key={speaker.id} value={speaker.id}>
              {speaker.label}
            </option>
          ))}
        </Select>
      ) : null}

      <p className="text-[13px] text-muted-foreground">
        <span className="font-semibold">{t("meeting.transcript.correction.original")}</span>{" "}
        {segment.text}
      </p>

      <div className="flex items-center gap-1.5">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-pill border border-border bg-card px-3 py-1.5 text-[13px] font-semibold text-muted-foreground transition-colors duration-micro ease-enter hover:text-foreground disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Check aria-hidden="true" className="size-3.5" />
          {t("meeting.transcript.correction.save")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={saving}
          className="flex items-center gap-1.5 rounded-pill px-3 py-1.5 text-[13px] font-semibold text-muted-foreground transition-colors duration-micro ease-enter hover:text-foreground disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X aria-hidden="true" className="size-3.5" />
          {t("meeting.transcript.correction.cancel")}
        </button>
      </div>

      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          {t("meeting.transcript.correction.failed")}
        </p>
      ) : null}
    </div>
  );
}
