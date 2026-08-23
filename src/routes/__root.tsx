import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { omarchyTheme } from "virtual:omarchy-theme";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "sonner";
import { WIDGET_BOOT_SCRIPT } from "@/lib/finance/widget-boot-script";
import appCss from "../styles.css?url";

const LOCAL_LEDGER_ROUTE = "/__folio/local-statements/ledger";
const LEDGER_PRELOAD = `window.__FOLIO_LEDGER_P=fetch(${JSON.stringify(LOCAL_LEDGER_ROUTE)}).then(function(r){return r.ok?r.json():null}).then(function(j){window.__FOLIO_LEDGER=j;return j}).catch(function(){return null});`;

const APP_NAME = "Omakei";

const FONT_HREF = omarchyTheme.enabled
  ? "https://fonts.googleapis.com/css2?family=JetBrains+Mono:ital,wght@0,400;0,500;0,600;0,700;1,500&display=swap"
  : "https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,500;0,9..144,600;1,9..144,500&family=Source+Sans+3:ital,wght@0,400;0,500;0,600;0,700&display=swap";

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      { title: APP_NAME },
      {
        name: "description",
        content:
          "Import bank, credit card, and mortgage statements into one clean ledger with a crisp monthly spend overview.",
      },
      {
        name: "theme-color",
        content: omarchyTheme.enabled ? omarchyTheme.background : "#F3EFE7",
      },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
      { rel: "preload", href: LOCAL_LEDGER_ROUTE, as: "fetch", crossOrigin: "anonymous" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
      },
      {
        rel: "stylesheet",
        href: FONT_HREF,
      },
    ],
  }),
  component: () => (
    <html
      lang="en"
      className={
        omarchyTheme.enabled && omarchyTheme.mode === "dark" ? "dark antialiased" : "antialiased"
      }
      suppressHydrationWarning
    >
      <head>
        <HeadContent />
        {omarchyTheme.enabled && omarchyTheme.css ? (
          <style id="omarchy-theme">{omarchyTheme.css}</style>
        ) : null}
        <script dangerouslySetInnerHTML={{ __html: LEDGER_PRELOAD }} />
      </head>
      <body>
        <style>{`@keyframes folio-spin{to{transform:rotate(360deg)}}`}</style>
        <div
          id="folio-boot"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 80,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--color-background, #111)",
          }}
        >
          <div
            aria-label="Loading ledger"
            style={{
              width: 32,
              height: 32,
              border:
                "2px solid color-mix(in srgb, var(--color-foreground, #fff) 20%, transparent)",
              borderTopColor: "var(--color-foreground, #fff)",
              borderRadius: "50%",
              animation: "folio-spin 0.7s linear infinite",
            }}
          />
        </div>
        <script dangerouslySetInnerHTML={{ __html: WIDGET_BOOT_SCRIPT }} />
        <TooltipProvider delayDuration={250}>
          <Outlet />
          <Toaster
            position="bottom-center"
            theme={omarchyTheme.enabled && omarchyTheme.mode === "dark" ? "dark" : "light"}
            richColors={false}
            toastOptions={{
              className: "font-sans",
            }}
          />
        </TooltipProvider>
        <Scripts />
      </body>
    </html>
  ),
});
