import * as React from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "@/features/auth/auth-provider";
import { callbackShape, hasRetriedCallback, markCallbackRetried } from "@/features/auth/callback";

/**
 * Redirect target of the Authorization Code flow. It exchanges the code, then
 * replaces the history entry so the code never stays in the address bar.
 *
 * Where it goes next is the location the user was heading for when the flow
 * started, which the sign-in screen put into the OIDC state.
 *
 * It also has to survive arriving in a tab that never started a sign-in. Opening the verification
 * link from a mail client does exactly that: the provider finishes the required action and sends a
 * real `code` here, but the state it has to be matched against lives in the *other* tab's session
 * storage. That tab did nothing wrong, so answering it with an error would be the app blaming the
 * user for opening their mail. The flow is simply started again instead — the browser is holding a
 * provider session by then, so the round trip is silent and ends signed in. See
 * `features/auth/callback.ts`.
 */
export function AuthCallbackRoute() {
  const { completeSignIn, signIn } = useAuth();
  const navigate = useNavigate();
  const { search } = useLocation();
  const { t } = useTranslation();
  const started = React.useRef(false);

  React.useEffect(() => {
    // React runs effects twice in development; the code may only be redeemed once.
    if (started.current) return;
    started.current = true;

    completeSignIn()
      .then((returnTo) => navigate(returnTo ?? "/meetings", { replace: true }))
      .catch(() => {
        // A response we could not use, once: start over rather than explain. Twice: something is
        // wrong that another round trip will not fix, and bouncing forever is worse than a screen.
        if (callbackShape(search) === "response" && !hasRetriedCallback()) {
          markCallbackRetried();
          void signIn();
          return;
        }
        navigate("/", { replace: true });
      });
  }, [completeSignIn, signIn, navigate, search]);

  return (
    <main className="flex min-h-dvh items-center justify-center text-muted-foreground">
      {t("auth.completing")}
    </main>
  );
}
