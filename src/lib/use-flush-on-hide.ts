import { useEffect, useRef } from "react";

/**
 * Run `flush` the moment the tab is hidden or the page is being unloaded — the
 * two points where a pending edit would otherwise be lost without a save.
 *
 * `flush` is read through a ref so the listeners can stay registered for the
 * component's whole life while still seeing the latest closure. Both events are
 * handled in the capture phase, ahead of anything else that might tear state
 * down.
 */
export function useFlushOnHide(flush: () => void): void {
  const latest = useRef(flush);
  latest.current = flush;

  useEffect(() => {
    function onVisibilityChange() {
      if (document.visibilityState === "hidden") latest.current();
    }
    function onPageHide() {
      latest.current();
    }
    document.addEventListener("visibilitychange", onVisibilityChange, true);
    window.addEventListener("pagehide", onPageHide, true);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange, true);
      window.removeEventListener("pagehide", onPageHide, true);
    };
  }, []);
}
