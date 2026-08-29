/**
 * One-off imports.
 *
 * The attached folder is the normal way statements get in — the server syncs
 * it on every open. This is for the exceptions: a file that lives somewhere
 * else, or a table pasted out of a bank's web page.
 */
import { useRef, useState } from "react";
import { Upload } from "lucide-react";
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
import { parseStatementFile } from "@/lib/finance/parse";
import { mergePreviews, parseDroppedFiles } from "@/lib/finance/statements";
import { importAndSave } from "@/lib/finance/sync";
import { ACCOUNT_KIND_LABEL, type AccountKind, type ImportFileResult } from "@/lib/finance/types";
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

  async function stage(files: File[]) {
    setBusy(true);
    try {
      const parsed = await parseDroppedFiles(files);
      if (parsed.length === 0) {
        toast.message("No OFX, QFX, or CSV statements in that drop");
        return;
      }
      setPreviews((prev) => mergePreviews(prev, parsed));
    } catch {
      toast.error("Could not read those files");
    } finally {
      setBusy(false);
    }
  }

  function addPasted() {
    if (!paste.trim()) return;
    setPreviews((prev) => mergePreviews(prev, [parseStatementFile("pasted.csv", paste)]));
    setPaste("");
  }

  async function commit() {
    if (previews.length === 0) return;
    setBusy(true);
    try {
      const summary = await importAndSave(previews);
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

  const totalRows = previews.reduce((n, p) => n + p.rows.length, 0);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-lg"
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          void stage(Array.from(e.dataTransfer.files));
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
      >
        <SheetHeader>
          <SheetTitle>Import a one-off file</SheetTitle>
          <SheetDescription>
            Statements in your attached folder sync on their own. Use this for anything that lives
            somewhere else. Duplicates are skipped either way.
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
              <span className="text-sm font-medium">Drop files, or click to choose</span>
              <span className="text-xs text-muted-foreground">OFX, QFX, OFC, CSV, or TSV</span>
            </button>
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.tsv,.ofx,.qfx,.ofc,.txt,text/csv"
              multiple
              className="hidden"
              onChange={(e) => {
                const list = e.target.files;
                e.target.value = "";
                if (list) void stage(Array.from(list));
              }}
            />

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
                ? "Reading"
                : totalRows
                  ? `${totalRows} rows ready · duplicates skipped`
                  : "Nothing staged yet"}
            </p>
            <Button onClick={() => void commit()} disabled={busy || totalRows === 0}>
              {busy ? "Importing" : "Import"}
            </Button>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
