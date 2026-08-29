import { Trash2 } from "lucide-react";
import { CategorySelect } from "@/components/omakei/category-select";
import { Button } from "@/components/ui/button";
import { saveLedgerNow } from "@/lib/finance/ledger-file";
import { useLedgerStore } from "@/lib/finance/store";
import { isTransferTx } from "@/lib/finance/transfers";
import type { Transaction } from "@/lib/finance/types";
import { cn, formatDay, formatMoney } from "@/lib/utils";

export function TransactionRow({ tx }: { tx: Transaction }) {
  const categorizeOne = useLedgerStore((s) => s.categorizeOne);
  const deleteTransaction = useLedgerStore((s) => s.deleteTransaction);
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-5">
      <p className="w-16 shrink-0 text-xs text-muted-foreground tabular-nums">
        {formatDay(tx.date)}
      </p>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{tx.description}</p>
        <p className="truncate text-xs text-muted-foreground">
          {tx.accountName}
          {isTransferTx(tx) ? " · transfer" : ""}
        </p>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <CategorySelect
          value={tx.categoryId}
          onChange={(id) => {
            categorizeOne(tx.id, id, true);
            void saveLedgerNow(useLedgerStore.getState());
          }}
          size="sm"
          placeholder={tx.categoryId ? undefined : "Set category"}
          className="w-36 sm:w-40"
        />
        <p
          className={cn(
            "ml-auto w-24 text-right text-sm tabular-nums sm:ml-0",
            isTransferTx(tx)
              ? "text-muted-foreground"
              : tx.amount < 0
                ? "text-spend"
                : "text-income",
          )}
        >
          {formatMoney(tx.amount, { sign: true })}
        </p>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Remove transaction"
          onClick={() => {
            deleteTransaction(tx.id);
            void saveLedgerNow(useLedgerStore.getState());
          }}
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </li>
  );
}
