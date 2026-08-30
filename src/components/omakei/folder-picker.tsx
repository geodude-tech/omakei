/**
 * Choosing the folder that holds your statements.
 *
 * The server browses real directories, so the folder you pick has a real path
 * — which is what lets the bar widget find the ledger on its own. A browser's
 * own directory prompt hands back an opaque handle and cannot do that, and a
 * dropped folder hands back copies of the files with no path at all.
 *
 * Picking is click-and-keyboard only, by design: nobody should have to know or
 * type where their statements live. The breadcrumb and the Places row are the
 * orientation, and each row carries the count of statements at or just below
 * it, so the folder you want is the one showing a number.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, CornerLeftUp, Folder, FolderOpen, House } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { browseFolders, type BrowseResult } from "@/lib/finance/server";

/** `/home/you/Bank/Credit` under `/home/you` → `~ › Bank › Credit`, each clickable. */
function crumbsFor(path: string, home: string) {
  const short = home && (path === home || path.startsWith(`${home}/`));
  const rest = short ? path.slice(home.length).replace(/^\//, "") : path.replace(/^\//, "");
  const base = short ? home : "";
  const names = rest ? rest.split("/") : [];
  const crumbs = [{ name: short ? "~" : "/", path: short ? home : "/" }];
  let at = base;
  for (const name of names) {
    at = `${at}/${name}`;
    crumbs.push({ name, path: at });
  }
  return crumbs;
}

function countLabel(n: number) {
  return n === 1 ? "1 statement" : `${n} statements`;
}

export function FolderPicker({
  open,
  onOpenChange,
  startAt,
  onChoose,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  startAt: string;
  onChoose: (path: string) => Promise<void> | void;
}) {
  const [listing, setListing] = useState<BrowseResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLUListElement>(null);

  const go = useCallback(async (path: string) => {
    setError("");
    try {
      setListing(await browseFolders(path));
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open that folder");
      return false;
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    setListing(null);
    // `startAt` can be a folder that has since moved, or a path a drop guessed
    // at. Home is always somewhere to stand, so a bad start is never a dead end.
    void go(startAt || "~").then((ok) => {
      if (!ok && startAt) void go("~");
    });
  }, [open, startAt, go]);

  /**
   * The rows carry real focus rather than a painted cursor, so arrows, Enter,
   * and a screen reader all agree on where you are. Landing on the first folder
   * — not on "Up one level", which would undo the step just taken — is what
   * makes the whole walk keyboard-only.
   */
  useEffect(() => {
    if (!listing) return;
    (rows("entry")[0] ?? rows()[0])?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listing?.path]);

  function rows(kind = "") {
    const selector = kind ? `[data-row="${kind}"]` : "[data-row]";
    return Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>(selector) ?? []);
  }

  const entries = listing?.entries ?? [];
  const crumbs = listing ? crumbsFor(listing.path, listing.home) : [];

  async function choose(path: string) {
    setBusy(true);
    try {
      await onChoose(path);
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!listing) return;
    // Enter is left to the focused row: it walks in, which is the common move.
    // The modifier commits, so the folder you are standing in is always one
    // chord away without reaching for the mouse.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void choose(listing.path);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const all = rows();
      const at = all.indexOf(document.activeElement as HTMLButtonElement);
      const step = e.key === "ArrowDown" ? 1 : -1;
      const next = at < 0 ? 0 : Math.min(all.length - 1, Math.max(0, at + step));
      all[next]?.focus();
      return;
    }
    if (e.key === "ArrowLeft" || e.key === "Backspace") {
      if (!listing.parent) return;
      e.preventDefault();
      void go(listing.parent);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full pb-0 sm:max-w-lg"
        onKeyDown={onKeyDown}
        // Radix would land on the close button; the folder list is the point.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <SheetHeader className="py-4">
          <SheetTitle>Choose your statements folder</SheetTitle>
          <SheetDescription>
            Omakei reads the exports there and writes <code>omakei-ledger.json</code> back
            beside them. Subfolders count.
          </SheetDescription>
        </SheetHeader>

        {listing ? (
          <div className="flex flex-wrap items-center gap-1 border-b border-border px-5 py-2">
            {listing.places.map((place) => (
              <Button
                key={place.path}
                variant={place.path === listing.path ? "secondary" : "ghost"}
                size="sm"
                className="h-7 px-2 text-xs"
                onClick={() => void go(place.path)}
              >
                {place.name === "Home" ? <House className="size-3.5" /> : null}
                {place.name}
              </Button>
            ))}
          </div>
        ) : null}

        <nav
          aria-label="Folder path"
          className="flex min-h-9 flex-wrap items-center gap-0.5 px-5 py-2 font-mono text-xs"
        >
          {crumbs.map((crumb, i) => (
            <span key={crumb.path} className="flex items-center gap-0.5">
              {i > 0 ? <span className="text-muted-foreground/50">/</span> : null}
              <button
                type="button"
                onClick={() => void go(crumb.path)}
                className={
                  i === crumbs.length - 1
                    ? "rounded px-1 py-0.5 font-medium text-foreground"
                    : "rounded px-1 py-0.5 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                }
              >
                {crumb.name}
              </button>
            </span>
          ))}
        </nav>

        {error ? <p className="px-5 pb-2 text-xs text-destructive">{error}</p> : null}

        <ScrollArea className="min-h-0 flex-1 border-y border-border">
          <ul ref={listRef} className="flex flex-col px-3 py-2">
            {listing?.parent ? (
              <li>
                <button
                  type="button"
                  data-row="up"
                  onClick={() => void go(listing.parent!)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm outline-none hover:bg-muted/60 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <CornerLeftUp className="size-4 shrink-0 text-muted-foreground" />
                  <span className="text-muted-foreground">Up one level</span>
                </button>
              </li>
            ) : null}
            {entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  data-row="entry"
                  onClick={() => void go(entry.path)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm outline-none hover:bg-muted/60 focus-visible:bg-muted focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  {entry.statements > 0 ? (
                    <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] text-secondary-foreground">
                      {entry.statements}
                    </span>
                  ) : null}
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </li>
            ))}
            {listing && entries.length === 0 ? (
              <li className="px-2 py-6 text-sm text-muted-foreground">
                No subfolders here. Statements in this folder still count.
              </li>
            ) : null}
            {!listing && !error ? (
              <li className="px-2 py-6 text-sm text-muted-foreground">Reading folders…</li>
            ) : null}
          </ul>
        </ScrollArea>

        <div className="flex items-center justify-between gap-3 px-5 py-4">
          <div className="flex min-w-0 flex-1 flex-col">
            <p className="truncate font-mono text-xs text-muted-foreground">
              {listing?.path ?? ""}
            </p>
            <p className="text-xs text-muted-foreground">
              {listing
                ? listing.statements > 0
                  ? `${countLabel(listing.statements)} here`
                  : "No statements here yet — Omakei will watch this folder"
                : ""}
            </p>
          </div>
          <Button
            className="shrink-0"
            onClick={() => listing && void choose(listing.path)}
            disabled={busy || !listing}
          >
            <FolderOpen className="size-4" />
            {busy ? "Attaching" : "Use this folder"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
