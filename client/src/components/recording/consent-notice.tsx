import { ShieldCheck } from "lucide-react";
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

/**
 * Shown every time a recording is started, before the microphone is requested.
 *
 * There is no "don't show again": informing the participants is the user's legal
 * responsibility and the reminder is part of the product, not fine print. The
 * dialog cannot be dismissed by clicking outside or pressing Escape — the choice
 * has to be made. Tone here is calm and factual, never playful.
 */
export function ConsentNotice({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();

  return (
    <AlertDialog open={open}>
      {/* Radix alert dialogs already ignore outside clicks; blocking Escape too
          makes the choice unavoidable, which is the point of this notice. */}
      <AlertDialogContent onEscapeKeyDown={(event) => event.preventDefault()}>
        <AlertDialogHeader>
          <div className="flex items-center gap-3">
            <span className="flex size-10 items-center justify-center rounded-md bg-info-subtle text-info">
              <ShieldCheck className="size-5" aria-hidden="true" />
            </span>
            <AlertDialogTitle>{t("consent.title")}</AlertDialogTitle>
          </div>
          <AlertDialogDescription>{t("consent.body")}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={onCancel}>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>{t("consent.confirm")}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
