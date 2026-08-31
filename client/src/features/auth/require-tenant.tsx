import * as React from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { apiUrl } from "@/env";
import { useAuth } from "@/features/auth/auth-provider";
import { tenantClaimState } from "@/features/auth/tenant";

/**
 * The last step of signing up, for the one sign-in where it is needed.
 *
 * A self-registered account exists at the identity provider before it has a workspace here, and
 * the token it first arrives with carries no tenant. Every screen behind this gate reads
 * tenant-scoped data, so it would answer 403 — which the user would read as the app being broken
 * rather than as their account being half a step from ready.
 *
 * So: the app asks the API to finish setting the account up, renews the token so the new tenant is
 * actually in it, and carries on. It happens once in an account's life. Every later sign-in decides
 * in one line — the claim is in the token, render the children — with no request at all, which is
 * why this is a claim check rather than a call to the API on every load.
 *
 * A token this gate cannot read is deliberately waved through. An expired or replaced token is not
 * an account waiting to be set up, and treating it as one would park a stale session on a setup
 * screen forever instead of letting the 401 machinery renew it or say that the session ended.
 */
export function RequireTenant({ children }: { children: React.ReactNode }) {
  const { accessToken, renewSession } = useAuth();
  const { t } = useTranslation();
  // Only the failure is state. "Working" is not: it is simply what being here without a tenant
  // and without a failure means, and deriving it keeps the effect from re-rendering on entry.
  const [failed, setFailed] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);

  // "unreadable" is grouped with "present" on purpose: both mean this gate has no work to do.
  const needsTenant = tenantClaimState(accessToken) === "absent";

  React.useEffect(() => {
    if (!needsTenant || failed || accessToken === null) return;

    let active = true;

    void (async () => {
      try {
        const response = await fetch(apiUrl("/api/me/tenant"), {
          method: "POST",
          headers: { authorization: `Bearer ${accessToken}` },
        });
        if (!response.ok) throw new Error(`provisioning failed: ${String(response.status)}`);
        // The token in hand still has no tenant — claims are minted at the provider. Renewing is
        // what turns the account that now exists into one this app can act as.
        await renewSession();
      } catch {
        if (active) setFailed(true);
      }
    })();

    return () => {
      active = false;
    };
  }, [needsTenant, failed, accessToken, renewSession, attempt]);

  if (!needsTenant) return <>{children}</>;

  if (failed) {
    return (
      <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
        <p role="alert" className="text-muted-foreground">
          {t("auth.setupFailed")}
        </p>
        <Button
          onClick={() => {
            setFailed(false);
            setAttempt((value) => value + 1);
          }}
        >
          {t("common.retry")}
        </Button>
      </div>
    );
  }

  return (
    <div
      role="status"
      className="flex min-h-dvh items-center justify-center px-6 text-center text-muted-foreground"
    >
      {t("auth.settingUp")}
    </div>
  );
}
