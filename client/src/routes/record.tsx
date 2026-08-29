import { Mic } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/layout/empty-state";

/**
 * Recording screen.
 *
 * The capture pipeline — consent notice, microphone, chunk streaming and the
 * local buffer — is built on top of this route in the recording flow change.
 * Until then the destination exists so the navigation is complete, and it says
 * plainly that recording is not available yet rather than pretending.
 */
export function RecordRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();

  return (
    <EmptyState
      icon={Mic}
      title={t("record.unavailable.title")}
      body={t("record.unavailable.body")}
    >
      <Button variant="secondary" onClick={() => void navigate("/meetings")}>
        {t("notFound.action")}
      </Button>
    </EmptyState>
  );
}
