import { useRef, useState } from "react";
import { Folder, Upload } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  canPickDirectory,
  collectDrop,
  markFolderLoadedThisSession,
  parseLocalStatement,
  parseStatementFiles,
  pickStatementsDirectory,
} from "@/lib/finance/folder";
import { importAndSave, syncAttachedFolder, toastFolderSync } from "@/lib/finance/folder-sync";
import { parseStatementFile } from "@/lib/finance/parse";
import {
  ACCOUNT_KIND_LABEL,
  type AccountKind,
  type ImportFileResult,
} from "@/lib/finance/types";
import { formatMoney, cn } from "@/lib/utils";

const KINDS: AccountKind[] = ["checking", "savings", "credit", "mortgage", "other"];

export function ImportSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [previews, setPreviews] = useState<ImportFileResult[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [paste, setPaste] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);

  async function ingestParsed(next: ImportFileResult[], rememberedFolder?: string | null) {
    if (next.length === 0) {
      toast.message("No statement files in that drop");
      return;
    }
    setPreviews((prev) => mergePreviews(prev, next));
    if (rememberedFolder) {
      markFolderLoadedThisSession();
      toast.success(`Staged ${next.length} file${next.length === 1 ? "" : "s"} from ${rememberedFolder}`);
    }
  }

  async function ingestFiles(fileList: FileList | File[]) {
    await ingestParsed(await parseStatementFiles(Array.from(fileList)));
  }

  async function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    setBusy(true);
    try {
      const { files, folder } = await collectDrop(e.dataTransfer);
      if (folder) {
        const result = await syncAttachedFolder(folder.handle, folder.name);
        toastFolderSync(result);
        onOpenChange(false);
        return;
      }
      await ingestParsed(files);
    } catch {
      toast.error("Could not read that folder");
    } finally {
      setBusy(false);
    }
  }

  async function chooseFolder() {
    setBusy(true);
    try {
      if (canPickDirectory()) {
        const folder = await pickStatementsDirectory();
        if (!folder) return;
        const result = await syncAttachedFolder(folder.handle, folder.name);
        toastFolderSync(result);
        onOpenChange(false);
        return;
      }
      folderInputRef.current?.click();
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      toast.error("Could not open that folder");
    } finally {
      setBusy(false);
    }
  }

  function addPasted() {
    if (!paste.trim()) return;
    const parsed = parseStatementFile("pasted.csv", paste);
    setPreviews((prev) => mergePreviews(prev, [parsed]));
    setPaste("");
  }

  async function commit() {
    if (previews.length === 0) return;
    const files = previews;
    setBusy(true);
    try {
      const summary = await importAndSave(files);
      setPreviews([]);
      onOpenChange(false);
      toast.success(
        `${summary.added} added · ${summary.skipped} duplicate${summary.skipped === 1 ? "" : "s"} skipped`,
      );
      if (summary.uncategorized > 0) {
        toast.message(`${summary.uncategorized} still need a category`);
      }
    } finally {
      setBusy(false);
    }
  }

  async function loadFromThisComputer() {
    setBusy(true);
    try {
      const listRes = await fetch("/__folio/local-statements");
      if (!listRes.ok) {
        toast.error("Local statements are only available on localhost in dev");
        return;
      }
      const list = (await listRes.json()) as {
        configured?: boolean;
        files?: Array<{ path: string; name: string }>;
        error?: string;
      };
      if (!list.configured) {
        toast.error("Set FOLIO_STATEMENTS_DIR in .env.local");
        return;
      }
      const files = list.files ?? [];
      if (files.length === 0) {
        toast.message("No statement files in the local folder");
        return;
      }
      const loaded = await Promise.all(
        files.map(async (file) => {
          const fileRes = await fetch(
            `/__folio/local-statements/file?path=${encodeURIComponent(file.path)}`,
          );
          if (!fileRes.ok) return null;
          const payload = (await fileRes.json()) as { path: string; text: string };
          return parseLocalStatement(payload.path, payload.text);
        }),
      );
      const next = loaded.filter((row): row is ImportFileResult => row !== null);
      if (next.length === 0) {
        toast.error("Could not read local statement files");
        return;
      }
      setPreviews((prev) => mergePreviews(prev, next));
      toast.success(`Staged ${next.length} file${next.length === 1 ? "" : "s"} from this computer`);
    } catch {
      toast.error("Could not load local statements");
    } finally {
      setBusy(false);
    }
  }

  const totalRows = previews.reduce((n, p) => n + p.rows.length, 0);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-lg"
        onDrop={onDrop}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
      >
        <SheetHeader>
          <SheetTitle>Import statements</SheetTitle>
          <SheetDescription>
            Choose a folder and Omakei syncs it — OFX, QFX, or CSV. Duplicates are skipped.
          </SheetDescription>
        </SheetHeader>

        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-5 px-5 py-5">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className={cn(
                "flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/40 px-4 py-6 text-center transition-[background-color,border-color] duration-150",
                dragOver && "border-primary bg-secondary",
              )}
            >
              <Upload className="size-5 text-primary" />
              <span className="text-sm font-medium">Drop a folder or files</span>
              <span className="text-xs text-muted-foreground">
                Nested checking, card, and mortgage exports are fine
              </span>
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.tsv,.ofx,.qfx,.txt,text/csv"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files) void ingestFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              ref={folderInputRef}
              type="file"
              className="hidden"
              multiple
              {...{ webkitdirectory: "" }}
              onChange={(e) => {
                const list = e.target.files;
                e.target.value = "";
                if (!list) return;
                void (async () => {
                  setBusy(true);
                  try {
                    const parsed = await parseStatementFiles(Array.from(list));
                    const summary = await importAndSave(parsed);
                    toast.success(
                      `${summary.added} added · ${summary.skipped} duplicate${summary.skipped === 1 ? "" : "s"} skipped`,
                    );
                    onOpenChange(false);
                  } catch {
                    toast.error("Could not read that folder");
                  } finally {
                    setBusy(false);
                  }
                })();
              }}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => inputRef.current?.click()} disabled={busy}>
                Choose files
              </Button>
              <Button type="button" variant="secondary" size="sm" onClick={() => void chooseFolder()} disabled={busy}>
                <Folder className="size-4" />
                Choose folder
              </Button>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="paste">Or paste a CSV</Label>
              <textarea
                id="paste"
                value={paste}
                onChange={(e) => setPaste(e.target.value)}
                rows={4}
                placeholder="Date, Description, Amount"
                className="w-full resize-y rounded-md border border-input bg-card px-3 py-2 text-sm shadow-[var(--shadow-border)] outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="self-start"
                onClick={addPasted}
                disabled={!paste.trim()}
              >
                Parse pasted text
              </Button>
            </div>

            {import.meta.env.DEV && (
              <Button
                type="button"
                variant="secondary"
                onClick={() => void loadFromThisComputer()}
                disabled={busy}
              >
                Load from this computer
              </Button>
            )}

            {previews.map((file, idx) => (
              <div key={`${file.filename}-${idx}`} className="rounded-lg bg-muted/50 p-3">
                <div className="mb-3 flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{file.filename}</p>
                    <p className="text-xs text-muted-foreground">
                      {file.rows.length} transactions
                      {file.warnings[0] ? ` · ${file.warnings[0]}` : ""}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPreviews((prev) => prev.filter((_, i) => i !== idx))}
                  >
                    Remove
                  </Button>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs text-muted-foreground">Account</Label>
                    <Input
                      value={file.accountName}
                      onChange={(e) =>
                        setPreviews((prev) =>
                          prev.map((p, i) =>
                            i === idx ? { ...p, accountName: e.target.value } : p,
                          ),
                        )
                      }
                      className="h-9"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <Label className="text-xs text-muted-foreground">Type</Label>
                    <Select
                      value={file.accountKind}
                      onValueChange={(kind) =>
                        setPreviews((prev) =>
                          prev.map((p, i) =>
                            i === idx ? { ...p, accountKind: kind as AccountKind } : p,
                          ),
                        )
                      }
                    >
                      <SelectTrigger className="h-9">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {KINDS.map((k) => (
                          <SelectItem key={k} value={k}>
                            {ACCOUNT_KIND_LABEL[k]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <ul className="mt-3 divide-y divide-border text-xs">
                  {file.rows.slice(0, 4).map((row, i) => (
                    <li key={i} className="flex items-center justify-between gap-2 py-1.5">
                      <span className="min-w-0 truncate text-muted-foreground">
                        {row.date} · {row.description}
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {formatMoney(row.amount, { sign: true })}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </ScrollArea>

        <div className="flex flex-col gap-3 border-t border-border px-5 pt-4 pb-16">
          <div className="flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              {busy
                ? "Syncing"
                : totalRows
                  ? `${totalRows} rows ready · duplicates skipped`
                  : "Nothing staged yet"}
            </p>
            <Button onClick={() => void commit()} disabled={busy || totalRows === 0}>
              {busy ? "Syncing" : "Sync"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function mergePreviews(prev: ImportFileResult[], next: ImportFileResult[]): ImportFileResult[] {
  const out = [...prev];
  for (const item of next) {
    const idx = out.findIndex((p) => p.filename === item.filename);
    if (idx >= 0) out[idx] = item;
    else out.push(item);
  }
  return out;
}
