import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Confirmation for the ADR-001 cascade.
 *
 * A no-playfulness zone (STATES.md §6): the body names exactly what is destroyed — audio,
 * transcripts, summaries — and says plainly that it cannot be undone. Cancel is the
 * default-focused action, and there is no "don't ask again": deletion is real, so the question
 * is asked every time.
 */
export function DeleteMeetingDialog({
  meetingLabel,
  open,
  onOpenChange,
  onConfirm,
}: {
  /** Title and date of the meeting, so the dialog names what is about to go. */
  meetingLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("meetings.delete.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("meetings.delete.body", { meeting: meetingLabel })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className={cn(buttonVariants({ variant: "destructive" }))}
            onClick={onConfirm}
          >
            {t("meetings.delete.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
