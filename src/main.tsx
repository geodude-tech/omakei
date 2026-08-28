import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Toaster } from "sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Dashboard } from "@/components/omakei/dashboard.tsx";
import "./styles.css";

const container = document.getElementById("root");
if (!container) throw new Error("missing #root");

/** The Omarchy theme is applied to <html> by the server, not by the bundle. */
const dark = document.documentElement.classList.contains("dark");

createRoot(container).render(
  <StrictMode>
    <TooltipProvider delayDuration={250}>
      <Dashboard />
      <Toaster
        position="bottom-center"
        theme={dark ? "dark" : "light"}
        richColors={false}
        toastOptions={{ className: "font-sans" }}
      />
    </TooltipProvider>
  </StrictMode>,
);
