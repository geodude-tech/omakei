/**
 * The dashed "drop statements here" target.
 *
 * Shared by the Import sheet and the dashboard's empty state so the two behave
 * identically. It takes loose files and — via the entries API — a dropped
 * folder, walked recursively; every statement it finds goes to `onFiles` with
 * its drop-relative path, so a `Credit/` or `Mortgage/` subfolder still reaches
 * the account-kind guess. Clicking opens a multi-file picker: a browser file
 * input hands back copies with no real path, so *attaching* the folder is the
 * FolderPicker's job and never this one's. A drop with nowhere to save yet
 * lands in that picker too.
 */
import { useRef, useState, type DragEvent, type ReactNode } from "react";
import { Upload } from "lucide-react";
import { droppedPath, filesFromDataTransfer } from "@/lib/finance/dropped-entries";
import { cn } from "@/lib/utils";

const ACCEPT = ".csv,.tsv,.ofx,.qfx,.ofc,.txt,text/csv";

export function StatementDropzone({
  onFiles,
  onPath,
  disabled = false,
  label = "Drop statements here, or click to choose files",
  hint = "OFX, QFX, OFC, CSV, or TSV",
  className,
}: {
  onFiles: (files: File[]) => void;
  /** The real path the drop came from, when the desktop sent one. */
  onPath?: (path: string) => void;
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
    // Both reads have to happen before the first await: a DataTransfer is
    // emptied the moment the drop event finishes.
    const dropped = Array.from(e.dataTransfer.items ?? [])
      .map((item) => item.webkitGetAsEntry?.() ?? null)
      .find((entry) => entry != null);
    const path = droppedPath(e.dataTransfer, dropped?.isDirectory ?? false);
    const files = await filesFromDataTransfer(e.dataTransfer);
    if (path) onPath?.(path);
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
