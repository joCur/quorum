// Self-hosted faces, bundled by Vite — no font CDN at runtime.
// Figtree carries text, Schibsted Grotesk the display sizes, JetBrains Mono
// the timers and timestamps. Only the weights the design system uses ship.
import "@fontsource/figtree/400.css";
import "@fontsource/figtree/500.css";
import "@fontsource/figtree/600.css";
import "@fontsource/figtree/700.css";
import "@fontsource/schibsted-grotesk/500.css";
import "@fontsource/schibsted-grotesk/700.css";
import "@fontsource/schibsted-grotesk/800.css";
import "@fontsource/schibsted-grotesk/900.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@/styles/index.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "@/App";
import { AuthProvider } from "@/features/auth/auth-provider";
import { ThemeProvider } from "@/features/theme/theme-provider";
import { Toaster } from "@/components/ui/toaster";
import "@/i18n";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container is missing from index.html");
}

createRoot(container).render(
  <StrictMode>
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
        {/* Outside the router: a confirmation has to outlive the navigation that often follows
            the action it confirms. */}
        <Toaster />
      </AuthProvider>
    </ThemeProvider>
  </StrictMode>,
);
