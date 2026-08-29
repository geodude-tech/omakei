/**
 * Choosing the folder that holds your statements.
 *
 * The server browses real directories, so the folder you pick has a real path
 * — which is what lets the bar widget find the ledger on its own. A browser's
 * own directory prompt hands back an opaque handle and cannot do that.
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronRight, CornerLeftUp, Folder, FolderOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { browseFolders, type BrowseResult } from "@/lib/finance/server";

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
  const [typed, setTyped] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const go = useCallback(async (path: string) => {
    setError("");
    try {
      const next = await browseFolders(path);
      setListing(next);
      setTyped(next.path);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open that folder");
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void go(startAt || "~");
  }, [open, startAt, go]);

  async function choose(path: string) {
    setBusy(true);
    try {
      await onChoose(path);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Attach your statements folder</SheetTitle>
          <SheetDescription>
            Point Omakei at the folder your exports already live in. It reads the
            statements there, writes <code>omakei-ledger.json</code> back beside them,
            and keeps the bar in sync. Subfolders are included.
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-2 px-5 pt-4">
          <Label htmlFor="folder-path">Folder path</Label>
          <div className="flex items-center gap-2">
            <Input
              id="folder-path"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void go(typed);
              }}
              placeholder="~/Documents/Statements"
              spellCheck={false}
              className="font-mono text-xs"
            />
            <Button variant="outline" size="sm" onClick={() => void go(typed)} disabled={busy}>
              Go
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Paste or type the path and press Go — or click through the folders below.
          </p>
        </div>
        {error ? <p className="px-5 pt-2 text-xs text-destructive">{error}</p> : null}

        <ScrollArea className="min-h-0 flex-1">
          <ul className="flex flex-col px-5 py-3">
            {listing?.parent ? (
              <li>
                <button
                  type="button"
                  onClick={() => void go(listing.parent!)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted/60"
                >
                  <CornerLeftUp className="size-4 shrink-0 text-muted-foreground" />
                  <span className="text-muted-foreground">Up one level</span>
                </button>
              </li>
            ) : null}
            {listing?.entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  onClick={() => void go(entry.path)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm hover:bg-muted/60"
                >
                  <Folder className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                  <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                </button>
              </li>
            ))}
            {listing && listing.entries.length === 0 ? (
              <li className="px-2 py-6 text-sm text-muted-foreground">
                No subfolders here. Statements in this folder still count.
              </li>
            ) : null}
          </ul>
        </ScrollArea>

        <div className="flex items-center justify-between gap-3 border-t border-border px-5 pt-4 pb-16">
          <p className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {typed || listing?.path || ""}
          </p>
          <Button
            onClick={() => {
              const target = typed.trim() || listing?.path;
              if (target) void choose(target);
            }}
            disabled={busy || !(typed.trim() || listing)}
          >
            <FolderOpen className="size-4" />
            {busy ? "Attaching" : "Attach this folder"}
          </Button>
        </div>
      </SheetContent>
    </Sheet>
  );
}
