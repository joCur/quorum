import { Navigate, Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/layout/app-shell";
import { RequireAuth } from "@/features/auth/require-auth";
import { LoginRoute } from "@/routes/login";
import { MeetingDetailRoute } from "@/routes/meeting-detail";
import { MeetingsRoute } from "@/routes/meetings";
import { NotFoundRoute } from "@/routes/not-found";
import { RecordRoute } from "@/routes/record";
import { SettingsRoute } from "@/routes/settings";
import { TemplatesRoute } from "@/routes/templates";

/**
 * Route table (UI structure §5). Everything except the sign-in screen sits behind the auth gate.
 *
 * SPIKE: the OIDC callback route is gone. Sign-in no longer leaves the app, so there is no
 * authorization code to redeem and no history entry to replace.
 */
export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />

      {/* The recording screen sits outside the shell: it is full-screen and
          distraction-free on every size, with no navigation competing with the
          record control. */}
      <Route
        path="/record"
        element={
          <RequireAuth>
            <RecordRoute />
          </RequireAuth>
        }
      />

      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route index element={<Navigate to="/meetings" replace />} />
        <Route path="/meetings" element={<MeetingsRoute />} />
        <Route path="/meetings/:meetingId" element={<MeetingDetailRoute />} />
        <Route path="/templates" element={<TemplatesRoute />} />
        <Route path="/settings" element={<SettingsRoute />} />
        <Route path="*" element={<NotFoundRoute />} />
      </Route>
    </Routes>
  );
}
