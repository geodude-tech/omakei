/**
 * The dashed "drop statements here" target.
 *
 * Shared by the Import sheet and the dashboard's empty state so the two behave
 * identically. It takes loose files and — via the entries API — a dropped
 * folder, walked recursively; every statement it finds goes to `onFiles` with
 * its drop-relative path, so a `Credit/` or `Mortgage/` subfolder still reaches
 * the account-kind guess. Clicking opens a multi-file picker (one input cannot
 * be both `multiple` and `webkitdirectory`; a whole folder goes in by drag, or
 * through the 3-dot menu's folder picker).
 */
import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { Upload } from "lucide-react";
import { filesFromDataTransfer } from "@/lib/finance/dropped-entries";
import { cn } from "@/lib/utils";

const ACCEPT = ".csv,.tsv,.ofx,.qfx,.ofc,.txt,text/csv";

export function StatementDropzone({
  onFiles,
  disabled = false,
  label = "Drop statements or a folder, or click to choose files",
  hint = "OFX, QFX, OFC, CSV, or TSV",
  className,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  label?: ReactNode;
  hint?: ReactNode;
  className?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  async function handleDrop(e: DragEvent) {
    e.preventDefault();
    setDragOver(false);
    if (disabled) return;
    const files = await filesFromDataTransfer(e.dataTransfer);
    if (files.length) onFiles(files);
  }

  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={() => inputRef.current?.click()}
        onDrop={handleDrop}
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        className={cn(
          "flex min-h-32 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-muted/40 px-4 py-6 text-center transition-[background-color,border-color] duration-150 disabled:opacity-60",
          dragOver && "border-primary bg-secondary",
          className,
        )}
      >
        <Upload className="size-5 text-primary" />
        <span className="text-sm font-medium">{label}</span>
        {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        className="hidden"
        onChange={(e) => {
          const list = e.target.files;
          e.target.value = "";
          if (list && list.length) onFiles(Array.from(list));
        }}
      />
    </>
  );
}
