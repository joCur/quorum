import { ListChecks } from "lucide-react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/layout/empty-state";

/**
 * Templates screen. The list and the editor are built in their own ticket; the
 * destination exists here so the navigation is complete and honest about what
 * the app can do today.
 */
export function TemplatesRoute() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-bold md:text-2xl">{t("templates.title")}</h1>
      <EmptyState
        icon={ListChecks}
        accent="plum"
        title={t("templates.empty.title")}
        body={t("templates.empty.body")}
      />
    </div>
  );
}
