import { toast } from "sonner";
import { CategorySelect } from "@/components/omakei/category-select";
import { Pager } from "@/components/omakei/pager";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { categoryName } from "@/lib/finance/categories";
import { saveLedgerNow } from "@/lib/finance/ledger-file";
import { useLedgerStore } from "@/lib/finance/store";
import { formatMoney } from "@/lib/utils";

export const MERCHANT_PAGE_SIZE = 12;

/** The merchants with no category yet, and a picker to name each one for good. */
export function NeedsCategoryPanel({
  merchants,
  total,
  page,
  pages,
  onPage,
}: {
  merchants: Array<{ merchant: string; count: number; total: number }>;
  total: number;
  page: number;
  pages: number;
  onPage: (page: number) => void;
}) {
  const categorizeMerchant = useLedgerStore((s) => s.categorizeMerchant);
  return (
    <Card>
      <CardHeader>
        <CardTitle>Needs a category</CardTitle>
        <p className="text-sm text-muted-foreground">
          Set it once — the identifier matches that merchant in any city.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {merchants.map((m) => (
          <div
            key={m.merchant}
            className="flex flex-col gap-2 rounded-md bg-muted/50 px-3 py-3 sm:flex-row sm:items-center"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{m.merchant}</p>
              <p className="text-xs text-muted-foreground">
                {m.count} {m.count === 1 ? "transaction" : "transactions"} ·{" "}
                {formatMoney(m.total, { sign: true })}
              </p>
            </div>
            <CategorySelect
              value={null}
              onChange={(id) => {
                categorizeMerchant(m.merchant, id);
                void saveLedgerNow(useLedgerStore.getState());
                toast.success(`Always categorize “${m.merchant}” as ${categoryName(id)}`);
              }}
              placeholder="Assign"
              size="sm"
              className="sm:w-48"
            />
          </div>
        ))}
        <Pager
          page={page}
          pages={pages}
          total={total}
          pageSize={MERCHANT_PAGE_SIZE}
          noun="merchants"
          onPage={onPage}
        />
      </CardContent>
    </Card>
  );
}
