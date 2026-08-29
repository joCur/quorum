import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Navigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-provider";

/** Sign-in screen: wordmark, one line of value, one button into the OIDC flow. */
export function LoginRoute() {
  const { t } = useTranslation();
  const { status, error, signIn } = useAuth();

  if (status === "authenticated") {
    return <Navigate to="/meetings" replace />;
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 px-6 text-center">
      <div className="flex flex-col gap-2">
        <span className="text-3xl font-bold tracking-tight">{t("app.name")}</span>
        <span className="text-base text-muted-foreground">{t("app.tagline")}</span>
      </div>

      {error ? (
        <p
          role="alert"
          className="flex max-w-sm items-start gap-2 rounded-md bg-destructive/10 p-3 text-left text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            {t("auth.error")} <span className="font-mono text-xs">{error}</span>
          </span>
        </p>
      ) : null}

      <Button size="lg" onClick={() => void signIn()} disabled={status === "loading"}>
        {t("auth.signIn")}
      </Button>
    </main>
  );
}
