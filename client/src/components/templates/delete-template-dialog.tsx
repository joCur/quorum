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
 * Confirmation for deleting a template (COMPONENTS.md §7: every destructive control gets one).
 *
 * Rendered straight, like the meeting dialog it mirrors — no playfulness anywhere near a delete.
 * The body says exactly what goes and, just as importantly, what does not: every summary carries
 * a snapshot of the template it was produced with (ADR-004 §2), so the summaries already written
 * with this template stay readable and stay explicable. Saying so is the difference between a
 * user deleting confidently and not deleting at all.
 *
 * Cancel is the default-focused action, and the question is asked every time.
 */
export function DeleteTemplateDialog({
  templateName,
  open,
  onOpenChange,
  onConfirm,
}: {
  /** Name of the template, so the dialog names what is about to go. */
  templateName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("templates.deleteDialog.title")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("templates.deleteDialog.body", { template: templateName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel autoFocus>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className={cn(buttonVariants({ variant: "destructive" }))}
            onClick={onConfirm}
          >
            {t("templates.deleteDialog.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
