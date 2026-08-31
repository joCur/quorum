import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/layout/app-shell";
import { RequireAuth } from "@/features/auth/require-auth";
import { RecordingProvider } from "@/features/recording/recording-provider";
import { AuthCallbackRoute } from "@/routes/auth-callback";
import { LoginRoute } from "@/routes/login";
import { MeetingDetailRoute } from "@/routes/meeting-detail";
import { MeetingsRoute } from "@/routes/meetings";
import { NotFoundRoute } from "@/routes/not-found";
import { RecordRoute } from "@/routes/record";
import { SettingsRoute } from "@/routes/settings";
import { TemplatesRoute } from "@/routes/templates";
import { AUTH_CALLBACK_PATH } from "@/features/auth/user-manager";

/**
 * Route table (UI structure §5). Everything except the sign-in flow sits behind
 * the auth gate; the template editor arrives with its own ticket.
 */
export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginRoute />} />
      <Route path={AUTH_CALLBACK_PATH} element={<AuthCallbackRoute />} />

      {/* One provider above every signed-in screen, the recording screen included: the running
          recording belongs to the app, not to the route that happened to start it, so navigating
          between these screens neither stops it nor loses sight of it. */}
      <Route
        element={
          <RequireAuth>
            <RecordingProvider>
              <Outlet />
            </RecordingProvider>
          </RequireAuth>
        }
      >
        {/* The recording screen sits outside the shell: it is full-screen and
            distraction-free on every size, with no navigation competing with the
            record control. */}
        <Route path="/record" element={<RecordRoute />} />

        <Route element={<AppShell />}>
          <Route index element={<Navigate to="/meetings" replace />} />
          <Route path="/meetings" element={<MeetingsRoute />} />
          <Route path="/meetings/:meetingId" element={<MeetingDetailRoute />} />
          <Route path="/templates" element={<TemplatesRoute />} />
          <Route path="/settings" element={<SettingsRoute />} />
          <Route path="*" element={<NotFoundRoute />} />
        </Route>
      </Route>
    </Routes>
  );
}
