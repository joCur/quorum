import * as React from "react";
import { Check, Pencil, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Input } from "@/components/ui/input";

/**
 * The meeting's name, and the way to change it.
 *
 * WHY IT IS EDITABLE HERE: a recording nobody named is named by its summary, and a suggestion its
 * owner cannot correct is not a suggestion. Clearing the field is allowed and means what it says
 * — the meeting goes back to unnamed, and a later summary may name it again.
 *
 * The heading is the resting state and the editor is the exception, rather than an input that
 * sits on the screen looking like a form: the title is something a user reads far more often than
 * they change. Enter saves, Escape restores what was there, and a failed save keeps the editor
 * open with the typed text — the one thing a rename must never do is swallow it.
 */
export function MeetingTitleField({
  title,
  placeholder,
  onRename,
}: {
  /** The stored name, or null when the meeting has none yet. */
  title: string | null;
  /** What stands in for a missing name, already translated. */
  placeholder: string;
  onRename: (title: string) => Promise<void>;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [failed, setFailed] = React.useState(false);

  const open = (): void => {
    setDraft(title ?? "");
    setFailed(false);
    setEditing(true);
  };

  const cancel = (): void => {
    setEditing(false);
    setFailed(false);
  };

  const save = async (): Promise<void> => {
    if (saving) return;
    // Nothing to store: the same text, or an empty field on a meeting that has no name anyway.
    if (draft.trim() === (title ?? "")) {
      cancel();
      return;
    }
    setSaving(true);
    setFailed(false);
    try {
      await onRename(draft);
      setEditing(false);
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  if (!editing) {
    return (
      <div className="flex min-w-0 items-center gap-1.5">
        <h1 className="truncate text-display-sm">{title ?? placeholder}</h1>
        <button
          type="button"
          onClick={open}
          aria-label={t("meeting.rename.action")}
          className="shrink-0 rounded-sm p-1 text-muted-foreground transition-colors duration-micro ease-enter hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Pencil aria-hidden="true" className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        <Input
          autoFocus
          value={draft}
          disabled={saving}
          aria-label={t("meeting.rename.label")}
          placeholder={t("meeting.rename.placeholder")}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void save();
            }
            if (event.key === "Escape") cancel();
          }}
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          aria-label={t("meeting.rename.save")}
          className="shrink-0 rounded-sm p-1.5 text-muted-foreground transition-colors duration-micro ease-enter hover:text-foreground disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Check aria-hidden="true" className="size-4" />
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={saving}
          aria-label={t("meeting.rename.cancel")}
          className="shrink-0 rounded-sm p-1.5 text-muted-foreground transition-colors duration-micro ease-enter hover:text-foreground disabled:pointer-events-none disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          {t("meeting.rename.failed")}
        </p>
      ) : null}
    </div>
  );
}
