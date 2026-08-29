import { Button } from "@/components/ui/button";

/** Previous/Next control under a paged list. Renders nothing when it all fits. */
export function Pager({
  page,
  pages,
  total,
  pageSize,
  noun,
  onPage,
}: {
  page: number;
  pages: number;
  total: number;
  pageSize: number;
  noun: string;
  onPage: (page: number) => void;
}) {
  if (total <= pageSize) return null;
  const from = page * pageSize + 1;
  const to = Math.min(total, (page + 1) * pageSize);
  return (
    <div className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-muted-foreground">
        {from}–{to} of {total} {noun}
      </p>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={page <= 0}
          aria-label={`Previous ${noun}`}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </Button>
        <Button
          variant="outline"
          size="sm"
          disabled={page >= pages - 1}
          aria-label={`Next ${noun}`}
          onClick={() => onPage(page + 1)}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
