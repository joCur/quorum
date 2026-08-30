import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/features/auth/auth-provider";
import { safeReturnTo } from "@/features/auth/session-expiry";

/**
 * Sign-in screen: wordmark, one line of value, and — new in this spike — the credential form
 * itself, because there is no provider to hand the user to any more.
 *
 * This is the part of the migration a screenshot shows better than a diff. With Keycloak the app
 * owned one button; the page behind it was somebody else's, in somebody else's design, with
 * somebody else's error messages and its own language negotiation. Here the whole thing is ours,
 * which is the argument both ways: it is the first screen a customer sees and it should look like
 * the product, and it is also a password form we now have to get right and keep right.
 *
 * Deliberately absent, and not an oversight: "Forgot password?" and "Create account". Neither
 * has anything to point at yet in either world — see the production-auth issue and the report.
 */
export function LoginRoute() {
  const { t } = useTranslation();
  const { status, error, sessionExpired, signIn } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const returnTo = safeReturnTo((location.state as { from?: unknown } | null)?.from);

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  if (status === "authenticated") {
    return <Navigate to={returnTo ?? "/meetings"} replace />;
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    try {
      await signIn(email, password);
      // The whole location the gate handed over, query and fragment included: a session that
      // ended while the user was reading a meeting brings them back to that meeting.
      navigate(returnTo ?? "/meetings", { replace: true });
    } catch {
      // `error` from the provider is what the user is shown; nothing to add here.
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-8 px-6">
      <div className="flex flex-col gap-2 text-center">
        <span className="text-3xl font-bold tracking-tight">{t("app.name")}</span>
        <span className="text-base text-muted-foreground">{t("app.tagline")}</span>
      </div>

      {sessionExpired && !error ? (
        <p role="status" className="max-w-sm text-center text-sm text-muted-foreground">
          {t("auth.sessionExpired")}
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="flex max-w-sm items-start gap-2 rounded-md bg-destructive/10 p-3 text-left text-sm text-destructive"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{t("auth.invalidCredentials")}</span>
        </p>
      ) : null}

      <form
        onSubmit={(event) => void submit(event)}
        className="flex w-full max-w-sm flex-col gap-4"
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">{t("auth.email")}</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="password">{t("auth.password")}</Label>
          <Input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </div>

        <Button type="submit" size="lg" disabled={submitting || status === "loading"}>
          {t("auth.signIn")}
        </Button>
      </form>
    </main>
  );
}
