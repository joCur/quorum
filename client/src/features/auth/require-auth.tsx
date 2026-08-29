import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useAuth } from "@/features/auth/auth-provider";

/** Gate around every screen that is not the sign-in flow. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const location = useLocation();
  const { t } = useTranslation();

  if (status === "loading") {
    return (
      <div className="flex min-h-dvh items-center justify-center text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }

  if (status !== "authenticated") {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <>{children}</>;
}
