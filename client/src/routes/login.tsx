import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation } from "react-router-dom";
import { Landing } from "@/components/landing/landing";
import { useAuth } from "@/features/auth/auth-provider";
import { safeReturnTo } from "@/features/auth/session-expiry";

/**
 * The signed-out view: the landing page, with sign-in as its single action.
 *
 * It is also where an expired session lands. The auth gate sends the location along, so signing in
 * again continues where the session ended instead of dropping the user at the meeting list — and
 * whatever the sign-in has to say, an ended session or a failed callback, is said in the hero
 * rather than on a screen of its own.
 */
export function LoginRoute() {
  const { t } = useTranslation();
  const { status, error, sessionExpired, signIn } = useAuth();
  const location = useLocation();
  const returnTo = safeReturnTo((location.state as { from?: unknown } | null)?.from);

  if (status === "authenticated") {
    return <Navigate to={returnTo ?? "/meetings"} replace />;
  }

  // A failed callback outranks an expired session: it is the thing that just happened, and saying
  // both would leave the user guessing which one to act on.
  const notice = error ? (
    <p
      role="alert"
      className="flex max-w-[52ch] items-start gap-2 rounded-card-sm bg-destructive/10 p-3 text-sm text-destructive"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <span>
        {t("auth.error")} <span className="font-mono text-xs">{error}</span>
      </span>
    </p>
  ) : sessionExpired ? (
    <p role="status" className="max-w-[52ch] text-sm text-muted-foreground">
      {t("auth.sessionExpired")}
    </p>
  ) : undefined;

  return (
    <Landing
      onSignIn={() => void signIn(returnTo)}
      signInDisabled={status === "loading"}
      notice={notice}
    />
  );
}
