import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  MoreHorizontal,
  RefreshCw,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { CategorySelect } from "@/components/omakei/category-select";
import { ImportSheet } from "@/components/omakei/import-sheet";
import { RulesSheet } from "@/components/omakei/rules-sheet";
import { AddSetAsideCell, SetAsideStat } from "@/components/omakei/set-aside-stat";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { CATEGORY_BY_ID, categoryName } from "@/lib/finance/categories";
import { exportLedgerCsv, isIncome, isSpend } from "@/lib/finance/ledger";
import { isTransferTx } from "@/lib/finance/transfers";
import { bootLedger } from "@/lib/finance/boot";
import { saveLedgerNow, setLedgerWritable } from "@/lib/finance/ledger-file";
import {
  attachFolder,
  detachFolder,
  writeLedger,
  type AttachedFolder,
} from "@/lib/finance/server";
import { syncAttachedFolder, toastSync } from "@/lib/finance/sync";
import { clearOpeningMonthFromUrl } from "@/lib/finance/opening-month";
import { availableNet, setAsideTotal } from "@/lib/finance/set-asides";
import { unknownMerchants, useLedgerStore } from "@/lib/finance/store";
import type { SetAside, Transaction } from "@/lib/finance/types";
import { FolderPicker } from "@/components/omakei/folder-picker";
import {
  cn,
  downloadTextFile,
  formatDay,
  formatMoney,
  formatMonthLabel,
  monthKey,
  shiftMonth,
} from "@/lib/utils";

const DailySpendChart = lazy(() => import("@/components/omakei/daily-spend-chart"));

const MERCHANT_PAGE_SIZE = 12;
const TX_PAGE_SIZE = 40;

const CHART_COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
  "var(--color-chart-6)",
  "var(--color-chart-7)",
];

export function Dashboard() {
  const transactions = useLedgerStore((s) => s.transactions);
  const selectedMonth = useLedgerStore((s) => s.selectedMonth);
  const initialized = useLedgerStore((s) => s.initialized);
  const setAsides = useLedgerStore((s) => s.setAsides);
  const setMonth = useLedgerStore((s) => s.setMonth);
  const clearLedger = useLedgerStore((s) => s.clearLedger);
  const addSetAside = useLedgerStore((s) => s.addSetAside);
  const updateSetAside = useLedgerStore((s) => s.updateSetAside);
  const removeSetAside = useLedgerStore((s) => s.removeSetAside);
  const [importOpen, setImportOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [focusSetAsideId, setFocusSetAsideId] = useState<string | null>(null);
  const [merchantPage, setMerchantPage] = useState(0);
  const [txPage, setTxPage] = useState(0);
  const [detailsReady, setDetailsReady] = useState(false);
  const [folder, setFolder] = useState<AttachedFolder | null>(null);
  const [home, setHome] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [syncing, setSyncing] = useState(false);

  useLayoutEffect(() => {
    if (!initialized) return;
    document.getElementById("omakei-boot")?.remove();
  }, [initialized]);

  useEffect(() => {
    if (!initialized) return;
    clearOpeningMonthFromUrl();
    // Charts and the long activity table wait a frame so the numbers above
    // them are on screen first.
    const id = requestAnimationFrame(() => {
      requestAnimationFrame(() => setDetailsReady(true));
    });
    return () => cancelAnimationFrame(id);
  }, [initialized]);

  useEffect(() => {
    let cancelled = false;
    void bootLedger().then((result) => {
      if (cancelled) return;
      setFolder(result.folder);
      setHome(result.home);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    function persistOnHide() {
      void saveLedgerNow(useLedgerStore.getState());
    }
    function persistIfHidden() {
      if (document.visibilityState === "hidden") persistOnHide();
    }
    document.addEventListener("visibilitychange", persistIfHidden);
    window.addEventListener("pagehide", persistOnHide);
    return () => {
      document.removeEventListener("visibilitychange", persistIfHidden);
      window.removeEventListener("pagehide", persistOnHide);
    };
  }, []);

  const months = useMemo(() => {
    const keys = new Set(transactions.map((t) => monthKey(t.date)));
    return [...keys].sort();
  }, [transactions]);

  const monthTx = useMemo(
    () => transactions.filter((t) => monthKey(t.date) === selectedMonth),
    [transactions, selectedMonth],
  );

  const stats = useMemo(() => summarize(monthTx, setAsides), [monthTx, setAsides]);
  const cats = useMemo(() => categoryTotals(monthTx), [monthTx]);
  const daily = useMemo(() => dailySpend(selectedMonth, monthTx), [selectedMonth, monthTx]);
  const unknowns = useMemo(
    () => (detailsReady ? unknownMerchants(transactions) : []),
    [detailsReady, transactions],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return monthTx.filter((t) => {
      if (categoryFilter === "all" && isTransferTx(t)) return false;
      if (categoryFilter === "transfers" && !isTransferTx(t)) return false;
      if (categoryFilter === "uncat" && t.categoryId) return false;
      if (
        categoryFilter !== "all" &&
        categoryFilter !== "uncat" &&
        categoryFilter !== "transfers" &&
        t.categoryId !== categoryFilter
      ) {
        return false;
      }
      if (!q) return true;
      return (
        t.description.toLowerCase().includes(q) ||
        t.accountName.toLowerCase().includes(q) ||
        categoryName(t.categoryId).toLowerCase().includes(q)
      );
    });
  }, [monthTx, query, categoryFilter]);

  const pagedUnknowns = useMemo(
    () => pageSlice(unknowns, merchantPage, MERCHANT_PAGE_SIZE),
    [unknowns, merchantPage],
  );
  const pagedTx = useMemo(
    () => pageSlice(filtered, txPage, TX_PAGE_SIZE),
    [filtered, txPage],
  );

  useEffect(() => {
    setMerchantPage(0);
  }, [selectedMonth, transactions.length]);

  useEffect(() => {
    setTxPage(0);
  }, [selectedMonth, query, categoryFilter]);

  const monthIndex = months.indexOf(selectedMonth);
  const prevMonth = monthIndex > 0 ? months[monthIndex - 1] : shiftMonth(selectedMonth, -1);
  const nextMonth =
    monthIndex >= 0 && monthIndex < months.length - 1
      ? months[monthIndex + 1]
      : shiftMonth(selectedMonth, 1);
  const canPrev = months.length ? selectedMonth > months[0]! : true;
  const canNext = months.length ? selectedMonth < months[months.length - 1]! : true;

  function exportCsv() {
    if (transactions.length === 0) {
      toast.message("Nothing to export yet");
      return;
    }
    downloadTextFile(`omakei-ledger.csv`, exportLedgerCsv(transactions), "text/csv;charset=utf-8");
    toast.success("Downloaded one clean ledger file");
  }

  /** Re-read the attached folder, or ask for one if none is attached yet. */
  async function resync() {
    if (syncing) return;
    if (!folder) {
      setPickerOpen(true);
      return;
    }
    setSyncing(true);
    try {
      toastSync(await syncAttachedFolder(folder.name));
    } catch {
      toast.error("Could not read the attached folder");
    } finally {
      setSyncing(false);
    }
  }

  async function attach(path: string) {
    try {
      const state = await attachFolder(path);
      if (!state.folder) {
        toast.error("Could not attach that folder");
        return;
      }
      setFolder(state.folder);
      setLedgerWritable(true, writeLedger);
      if (state.ledger) useLedgerStore.getState().loadSnapshot(state.ledger);
      setPickerOpen(false);
      toastSync(await syncAttachedFolder(state.folder.name));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not attach that folder");
    }
  }

  async function detach() {
    await detachFolder().catch(() => null);
    setLedgerWritable(false);
    setFolder(null);
    toast.message("Detached the folder. Your files are untouched.");
  }

  if (!initialized) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-background">
        <div
          className="size-8 animate-spin rounded-full border-2 border-muted border-t-foreground"
          aria-label="Loading ledger"
        />
      </div>
    );
  }

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <header className="sticky top-0 z-30 border-b border-border bg-background/90 backdrop-blur-sm">
        <div className="mx-auto flex max-w-6xl items-center gap-3 px-4 py-3 sm:px-6">
          <div className="min-w-0 flex-1">
            <p className="font-display text-xl font-medium tracking-tight italic sm:text-2xl">Omakei</p>
            <p className="hidden text-xs text-muted-foreground sm:block">
              {folder ? `Saved in ${folder.name}/omakei-ledger.json` : "Every statement, one ledger"}
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-lg bg-card px-1 shadow-[var(--shadow-border)]">
            <Button variant="ghost" size="icon-sm" aria-label="Previous month" disabled={!canPrev} onClick={() => setMonth(prevMonth)}>
              <ChevronLeft />
            </Button>
            <p className="min-w-32 text-center font-display text-sm font-medium sm:min-w-40 sm:text-base">
              {formatMonthLabel(selectedMonth)}
            </p>
            <Button variant="ghost" size="icon-sm" aria-label="Next month" disabled={!canNext} onClick={() => setMonth(nextMonth)}>
              <ChevronRight />
            </Button>
          </div>
          <Button
            onClick={() => void resync()}
            disabled={syncing}
            className="hidden sm:inline-flex"
          >
            <RefreshCw className={cn(syncing && "animate-spin")} />
            {syncing ? "Syncing" : folder ? "Sync" : "Attach folder"}
          </Button>
          <Button
            size="icon"
            className="sm:hidden"
            aria-label={syncing ? "Syncing statements" : "Sync statements"}
            disabled={syncing}
            onClick={() => void resync()}
          >
            <RefreshCw className={cn(syncing && "animate-spin")} />
          </Button>
          <Button variant="outline" onClick={() => setImportOpen(true)} className="hidden sm:inline-flex">
            <Upload /> Import
          </Button>
          <Button
            variant="outline"
            size="icon"
            className="sm:hidden"
            aria-label="Import statements"
            onClick={() => setImportOpen(true)}
          >
            <Upload />
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="More">
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={exportCsv}>
                <Download className="size-4" /> Download clean file
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setRulesOpen(true)}>Auto-categorize rules</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setPickerOpen(true)}>
                {folder ? "Change folder" : "Attach a folder"}
              </DropdownMenuItem>
              {folder ? (
                <DropdownMenuItem onClick={() => void detach()}>
                  Detach {folder.name}
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setClearOpen(true)}>Clear ledger</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-6 pb-16 sm:px-6 sm:py-8">
        {transactions.length === 0 ? (
          <button
            type="button"
            onClick={() => void resync()}
            disabled={syncing}
            className="flex flex-col items-center gap-3 rounded-xl bg-card px-6 py-14 text-center shadow-[var(--shadow-border)] transition-colors hover:bg-muted/40"
          >
            <Upload className="size-6 text-primary" />
            <span className="font-display text-xl font-medium tracking-tight">
              {syncing ? "Syncing…" : folder ? "No transactions yet" : "Choose a folder of statements"}
            </span>
            <span className="max-w-md text-sm text-muted-foreground">
              {folder
                ? `Drop OFX, QFX, or CSV exports into ${folder.name} and sync again.`
                : "OFX, QFX, or CSV from your bank. Omakei writes the ledger into that folder and the bar picks it up on its own."}
            </span>
          </button>
        ) : null}
        <section className="grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-border shadow-[var(--shadow-border)] md:grid-cols-4">
          <Stat label="Spent" value={formatMoney(stats.spent)} tone="spend" />
          <Stat label="Income" value={formatMoney(stats.income)} tone="income" />
          <Stat
            label="Net"
            value={formatMoney(stats.net, { sign: true })}
            tone={stats.net >= 0 ? "income" : "spend"}
            hint={
              stats.allocated > 0
                ? `after ${formatMoney(stats.allocated)} reserved this month`
                : undefined
            }
            hintTone="reserved"
          />
          <Stat
            label="Uncategorized"
            value={String(stats.uncategorized)}
            hint={stats.uncategorized ? "this month" : "All sorted"}
          />
          {setAsides.map((item) => (
            <SetAsideStat
              key={item.id}
              item={item}
              autoFocus={focusSetAsideId === item.id}
              onChange={(patch) => updateSetAside(item.id, patch)}
              onCommit={() => {
                void saveLedgerNow(useLedgerStore.getState());
              }}
              onRemove={() => {
                removeSetAside(item.id);
                if (focusSetAsideId === item.id) setFocusSetAsideId(null);
                void saveLedgerNow(useLedgerStore.getState());
              }}
            />
          ))}
          <AddSetAsideCell
            className={addSetAsideSpan(4 + setAsides.length + 1)}
            onClick={() => {
              const id = addSetAside();
              setFocusSetAsideId(id);
              void saveLedgerNow(useLedgerStore.getState());
            }}
          />
        </section>

        <div className="grid gap-4 lg:grid-cols-5">
          <Card className="lg:col-span-3">
            <CardHeader><CardTitle>Where it went</CardTitle></CardHeader>
            <CardContent>
              {!detailsReady ? (
                <Skeleton className="h-40" />
              ) : cats.length === 0 ? (
                <p className="py-10 text-sm text-muted-foreground">No spending this month.</p>
              ) : (
                <ul className="flex flex-col gap-3">
                  {cats.map((row, i) => (
                    <li key={row.id}>
                      <div className="mb-1 flex items-baseline justify-between gap-3">
                        <span className="text-sm">{row.name}</span>
                        <span className="text-sm tabular-nums">{formatMoney(row.total)}</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.max(4, (row.total / cats[0]!.total) * 100)}%`,
                            background: CHART_COLORS[i % CHART_COLORS.length],
                          }}
                        />
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardHeader><CardTitle>Daily spend</CardTitle></CardHeader>
            <CardContent>
              <div className="h-52">
                {detailsReady ? (
                  <Suspense fallback={<Skeleton className="h-full" />}>
                    <DailySpendChart data={daily} />
                  </Suspense>
                ) : (
                  <Skeleton className="h-full" />
                )}
              </div>
            </CardContent>
          </Card>
        </div>

        {detailsReady && unknowns.length > 0 ? (
          <UnknownPanel
            merchants={pagedUnknowns.items}
            total={unknowns.length}
            page={pagedUnknowns.page}
            pages={pagedUnknowns.pages}
            onPage={setMerchantPage}
          />
        ) : null}

        <section className="rounded-xl bg-card shadow-[var(--shadow-border)]">
          <div className="flex flex-col gap-3 border-b border-border px-4 py-4 sm:flex-row sm:items-center sm:px-5">
            <div>
              <h2 className="font-display text-lg font-medium">Activity</h2>
              <p className="text-xs text-muted-foreground">
                {detailsReady ? `${filtered.length} this month` : "Loading activity"}
                {detailsReady && categoryFilter === "all" ? " · transfers hidden" : ""}
              </p>
            </div>
            <div className="flex flex-1 flex-col gap-2 sm:flex-row sm:justify-end">
              <div className="relative sm:max-w-xs sm:flex-1">
                <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search merchants" className="pl-9" aria-label="Search transactions" />
              </div>
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="h-11 rounded-md border border-input bg-card px-3 text-sm shadow-[var(--shadow-border)]"
                aria-label="Filter by category"
              >
                <option value="all">Spending & income</option>
                <option value="transfers">Transfers</option>
                <option value="uncat">Uncategorized</option>
                {cats.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            </div>
          </div>
          {!detailsReady ? (
            <div className="flex flex-col gap-3 px-5 py-6">
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
              <Skeleton className="h-12" />
            </div>
          ) : filtered.length === 0 ? (
            <p className="px-5 py-12 text-center text-sm text-muted-foreground">Nothing matches this month.</p>
          ) : (
            <>
              <ul className="divide-y divide-border">
                {pagedTx.items.map((tx) => (
                  <TransactionRow key={tx.id} tx={tx} />
                ))}
              </ul>
              <Pager
                page={pagedTx.page}
                pages={pagedTx.pages}
                total={filtered.length}
                pageSize={TX_PAGE_SIZE}
                noun="transactions"
                onPage={setTxPage}
              />
            </>
          )}
        </section>
        <p className="pb-20 text-center text-xs text-muted-foreground">Stored only on this device. Download the clean file anytime.</p>
      </main>

      <ImportSheet open={importOpen} onOpenChange={setImportOpen} />
      <FolderPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        startAt={folder?.path || home}
        onChoose={attach}
      />
      <RulesSheet open={rulesOpen} onOpenChange={setRulesOpen} />
      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear the ledger?</AlertDialogTitle>
            <AlertDialogDescription>Transactions on this device will be removed. Auto-categorize rules stay.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                clearLedger();
                void saveLedgerNow(useLedgerStore.getState());
                toast.success("Ledger cleared");
              }}
            >
              Clear
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
  hint,
  hintTone,
}: {
  label: string;
  value: string;
  tone?: "income" | "spend" | "reserved";
  hint?: string;
  hintTone?: "reserved";
}) {
  return (
    <div className="bg-card px-4 py-4 sm:px-5" data-stat={label.toLowerCase()}>
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{label}</p>
      <p className={cn("mt-1 font-display text-2xl font-medium tracking-tight tabular-nums sm:text-3xl", tone === "income" && "text-income", tone === "spend" && "text-spend", tone === "reserved" && "text-reserved")}>{value}</p>
      {hint ? (
        <p className={cn("mt-1 text-xs", hintTone === "reserved" ? "text-reserved" : "text-muted-foreground")}>{hint}</p>
      ) : null}
    </div>
  );
}

function UnknownPanel({
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
        <p className="text-sm text-muted-foreground">Set it once — the identifier matches that merchant in any city.</p>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {merchants.map((m) => (
          <div key={m.merchant} className="flex flex-col gap-2 rounded-md bg-muted/50 px-3 py-3 sm:flex-row sm:items-center">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{m.merchant}</p>
              <p className="text-xs text-muted-foreground">
                {m.count} {m.count === 1 ? "transaction" : "transactions"} · {formatMoney(m.total, { sign: true })}
              </p>
            </div>
            <CategorySelect
              value={null}
              onChange={(id) => {
                categorizeMerchant(m.merchant, id);
                void saveLedgerNow(useLedgerStore.getState());
                toast.success(`Always categorize \u201c${m.merchant}\u201d as ${categoryName(id)}`);
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

function TransactionRow({ tx }: { tx: Transaction }) {
  const categorizeOne = useLedgerStore((s) => s.categorizeOne);
  const deleteTransaction = useLedgerStore((s) => s.deleteTransaction);
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4 sm:px-5">
      <p className="w-16 shrink-0 text-xs text-muted-foreground tabular-nums">{formatDay(tx.date)}</p>
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
            isTransferTx(tx) ? "text-muted-foreground" : tx.amount < 0 ? "text-spend" : "text-income",
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

function addSetAsideSpan(cellCount: number): string {
  const sm = 2 - ((cellCount % 2) || 2) + 1;
  const md = 4 - ((cellCount % 4) || 4) + 1;
  return cn(sm > 1 && "col-span-2", {
    "md:col-span-2": md === 2,
    "md:col-span-3": md === 3,
    "md:col-span-4": md === 4,
  });
}

function summarize(rows: Transaction[], setAsides: SetAside[]) {
  let spent = 0;
  let income = 0;
  let uncategorized = 0;
  for (const tx of rows) {
    if (isSpend(tx)) spent += Math.abs(tx.amount);
    if (isIncome(tx)) income += tx.amount;
    if (!tx.categoryId) uncategorized += 1;
  }
  const cashflow = income - spent;
  const allocated = setAsideTotal(setAsides);
  return { spent, income, cashflow, allocated, net: availableNet(cashflow, setAsides), uncategorized };
}

function pageSlice<T>(items: T[], page: number, pageSize: number) {
  const pages = Math.max(1, Math.ceil(items.length / pageSize) || 1);
  const safe = Math.min(Math.max(0, page), pages - 1);
  return {
    items: items.slice(safe * pageSize, (safe + 1) * pageSize),
    page: safe,
    pages,
    total: items.length,
  };
}

function Pager({
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

function categoryTotals(rows: Transaction[]) {
  const map = new Map<string, number>();
  for (const tx of rows) {
    if (!isSpend(tx)) continue;
    const id = tx.categoryId ?? "other";
    map.set(id, (map.get(id) ?? 0) + Math.abs(tx.amount));
  }
  return [...map.entries()]
    .map(([id, total]) => ({ id, name: CATEGORY_BY_ID[id]?.name ?? "Other", total }))
    .sort((a, b) => b.total - a.total);
}

function dailySpend(month: string, rows: Transaction[]) {
  const [y, m] = month.split("-").map(Number);
  const days = new Date(y, m, 0).getDate();
  const totals = Array.from({ length: days }, () => 0);
  for (const tx of rows) {
    if (!isSpend(tx)) continue;
    const d = Number(tx.date.slice(8, 10));
    if (d >= 1 && d <= days) totals[d - 1] += Math.abs(tx.amount);
  }
  return totals.map((spent, i) => ({
    day: String(i + 1),
    spent: Math.round(spent * 100) / 100,
    label: formatDay(`${month}-${String(i + 1).padStart(2, "0")}`),
  }));
}
