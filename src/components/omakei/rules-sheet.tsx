import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { categoryName } from "@/lib/finance/categories";
import { useLedgerStore } from "@/lib/finance/store";

export function RulesSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const rules = useLedgerStore((s) => s.rules);
  const deleteRule = useLedgerStore((s) => s.deleteRule);
  const userRules = rules.filter((r) => r.source === "user");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>Auto-categorize rules</SheetTitle>
          <SheetDescription>
            The rules you've made by giving an uncategorized merchant a category.
            Each is a key identifier, not the whole bank line — matching ignores
            town and store number, so <span className="font-mono">safeway</span> hits
            every Safeway. Delete one to stop it applying. Bulk edits and regex
            patterns are a terminal job —{" "}
            <span className="font-mono">scripts/omakei-categorize.mjs</span>.
          </SheetDescription>
        </SheetHeader>
        <ScrollArea className="min-h-0 flex-1">
          <div className="px-5 py-4">
            {userRules.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No custom rules yet. Assign a category to an unknown merchant and
                Omakei remembers it.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {userRules.map((rule) => (
                  <li
                    key={rule.id}
                    className="flex items-center justify-between gap-3 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate font-mono text-sm">{rule.pattern}</p>
                      <p className="text-xs text-muted-foreground">
                        {categoryName(rule.categoryId)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={`Delete rule ${rule.pattern}`}
                      onClick={() => deleteRule(rule.id)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
