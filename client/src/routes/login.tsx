import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/features/auth/auth-provider";
import { safeReturnTo } from "@/features/auth/session-expiry";

/**
 * Sign-in screen: wordmark, one line of value, one button into the OIDC flow.
 *
 * It is also where an expired session lands. The auth gate sends the location along, so signing in
 * again continues where the session ended instead of dropping the user at the meeting list.
 */
export function LoginRoute() {
  const { t } = useTranslation();
  const { status, error, sessionExpired, signIn } = useAuth();
  const location = useLocation();
  const returnTo = safeReturnTo((location.state as { from?: unknown } | null)?.from);

  if (status === "authenticated") {
    return <Navigate to={returnTo ?? "/meetings"} replace />;
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 px-6 text-center">
      <div className="flex flex-col gap-2">
        <span className="text-3xl font-bold tracking-tight">{t("app.name")}</span>
        <span className="text-base text-muted-foreground">{t("app.tagline")}</span>
      </div>

      {sessionExpired && !error ? (
        <p role="status" className="max-w-sm text-sm text-muted-foreground">
          {t("auth.sessionExpired")}
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="flex max-w-sm items-start gap-2 rounded-md bg-destructive/10 p-3 text-left text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {/* Never the OIDC library's own message: those are written for whoever is debugging
              the library, and one of them ("No matching state found in storage") reached real
              users. The reason is a code, and the sentence comes from i18n like every other. */}
          <span>{t(error === "provider_declined" ? "auth.errorDeclined" : "auth.error")}</span>
        </p>
      ) : null}

      <Button size="lg" onClick={() => void signIn(returnTo)} disabled={status === "loading"}>
        {t("auth.signIn")}
      </Button>
    </main>
  );
}
