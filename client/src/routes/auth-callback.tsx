import * as React from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useAuth } from "@/features/auth/auth-provider";

/**
 * Redirect target of the Authorization Code flow. It exchanges the code, then
 * replaces the history entry so the code never stays in the address bar.
 *
 * Where it goes next is the location the user was heading for when the flow
 * started, which the sign-in screen put into the OIDC state.
 */
export function AuthCallbackRoute() {
  const { completeSignIn } = useAuth();
  const navigate = useNavigate();
  const { t } = useTranslation();
  const started = React.useRef(false);

  React.useEffect(() => {
    // React runs effects twice in development; the code may only be redeemed once.
    if (started.current) return;
    started.current = true;

    completeSignIn()
      .then((returnTo) => navigate(returnTo ?? "/meetings", { replace: true }))
      .catch(() => navigate("/login", { replace: true }));
  }, [completeSignIn, navigate]);

  return (
    <main className="flex min-h-dvh items-center justify-center text-muted-foreground">
      {t("auth.completing")}
    </main>
  );
}
