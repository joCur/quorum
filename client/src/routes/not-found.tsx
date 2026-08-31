import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";

export function NotFoundRoute() {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <h1 className="text-display-lg">{t("notFound.title")}</h1>
      <p className="text-muted-foreground">{t("notFound.body")}</p>
      <Button asChild variant="secondary">
        <Link to="/meetings">{t("notFound.action")}</Link>
      </Button>
    </div>
  );
}
