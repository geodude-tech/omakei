import { createRootRoute, Outlet } from "@tanstack/react-router";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "sonner";

/** The Omarchy theme is applied to <html> by the server, not by the bundle. */
function isDark(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

export const Route = createRootRoute({
  component: () => (
    <TooltipProvider delayDuration={250}>
      <Outlet />
      <Toaster
        position="bottom-center"
        theme={isDark() ? "dark" : "light"}
        richColors={false}
        toastOptions={{ className: "font-sans" }}
      />
    </TooltipProvider>
  ),
});
