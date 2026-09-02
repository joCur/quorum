import { Navigate, Outlet, Route, Routes } from "react-router-dom";
import { AppShell } from "@/components/layout/app-shell";
import { RequireAuth } from "@/features/auth/require-auth";
import { RequireTenant } from "@/features/auth/require-tenant";
import { RecordingProvider } from "@/features/recording/recording-provider";
import { AuthCallbackRoute } from "@/routes/auth-callback";
import { LegalPlaceholderRoute, LEGAL_PATHS } from "@/routes/legal";
import { LandingRoute } from "@/routes/landing";
import { MeetingDetailRoute } from "@/routes/meeting-detail";
import { MeetingsRoute } from "@/routes/meetings";
import { NotFoundRoute } from "@/routes/not-found";
import { RecordRoute } from "@/routes/record";
import { SettingsRoute } from "@/routes/settings";
import { SettingsVocabularyRoute } from "@/routes/settings-vocabulary";
import { TemplatesRoute } from "@/routes/templates";
import { AUTH_CALLBACK_PATH } from "@/features/auth/user-manager";

/**
 * Route table (UI structure §5). Everything except the landing page, the sign-in flow and the
 * legal pages sits behind the auth gate.
 */
export function App() {
  return (
    <Routes>
      {/* The product's root: the landing page for a signed-out visitor, the app for a signed-in
          one. The landing route itself decides which, because that decision needs the session. */}
      <Route path="/" element={<LandingRoute />} />

      {/* The landing used to live here. Bookmarks and typed URLs still arrive, and they belong at
          the root now. */}
      <Route path="/login" element={<Navigate to="/" replace />} />

      <Route path={AUTH_CALLBACK_PATH} element={<AuthCallbackRoute />} />

      {/* Public on purpose: an imprint nobody can read without an account is not an imprint. */}
      <Route path={LEGAL_PATHS.imprint} element={<LegalPlaceholderRoute page="imprint" />} />
      <Route path={LEGAL_PATHS.privacy} element={<LegalPlaceholderRoute page="privacy" />} />

      {/* One provider above every signed-in screen, the recording screen included: the running
          recording belongs to the app, not to the route that happened to start it, so navigating
          between these screens neither stops it nor loses sight of it. */}
      <Route
        element={
          <RequireAuth>
            {/* Signed in is not the same as ready: a self-registered account gets its workspace
                here, once, on its first sign-in. */}
            <RequireTenant>
              <RecordingProvider>
                <Outlet />
              </RecordingProvider>
            </RequireTenant>
          </RequireAuth>
        }
      >
        {/* The recording screen sits outside the shell: it is full-screen and
            distraction-free on every size, with no navigation competing with the
            record control. */}
        <Route path="/record" element={<RecordRoute />} />

        <Route element={<AppShell />}>
          <Route path="/meetings" element={<MeetingsRoute />} />
          <Route path="/meetings/:meetingId" element={<MeetingDetailRoute />} />
          <Route path="/templates" element={<TemplatesRoute />} />
          <Route path="/settings" element={<SettingsRoute />} />
          <Route path="/settings/vocabulary" element={<SettingsVocabularyRoute />} />
          <Route path="*" element={<NotFoundRoute />} />
        </Route>
      </Route>
    </Routes>
  );
}
