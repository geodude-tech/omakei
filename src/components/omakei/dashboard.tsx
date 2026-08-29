import { useEffect, useLayoutEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  MoreHorizontal,
  RefreshCw,
  Search,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { ImportSheet } from "@/components/omakei/import-sheet";
import { NeedsCategoryPanel, MERCHANT_PAGE_SIZE } from "@/components/omakei/needs-category";
import { Pager } from "@/components/omakei/pager";
import { RulesSheet } from "@/components/omakei/rules-sheet";
import { AddSetAsideCell, SetAsideStat } from "@/components/omakei/set-aside-stat";
import { Stat } from "@/components/omakei/stat";
import { TransactionRow } from "@/components/omakei/transaction-row";
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { categoryName } from "@/lib/finance/categories";
import { exportLedgerCsv } from "@/lib/finance/ledger";
import { categoryTotals, monthSummary } from "@/lib/finance/summaries.ts";
import { PanelGrid } from "@/lib/panels/panel-grid.tsx";
import { isTransferTx } from "@/lib/finance/transfers";
import { bootLedger } from "@/lib/finance/boot";
import { saveLedgerNow, setLedgerWritable } from "@/lib/finance/ledger-file";
import { attachFolder, detachFolder, writeLedger, type AttachedFolder } from "@/lib/finance/server";
import { syncAttachedFolder, toastSync } from "@/lib/finance/sync";
import { clearOpeningMonthFromUrl } from "@/lib/finance/opening-month";
import { unknownMerchants, useLedgerStore } from "@/lib/finance/store";
import type { Transaction } from "@/lib/finance/types";
import { FolderPicker } from "@/components/omakei/folder-picker";
import { pageSlice } from "@/lib/paginate";
import { trailingCellSpan } from "@/lib/grid";
import {
  cn,
  downloadTextFile,
  formatMoney,
  formatMonthLabel,
  monthKey,
  shiftMonth,
} from "@/lib/utils";

const TX_PAGE_SIZE = 40;

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

  const stats = useMemo(() => monthSummary(monthTx, setAsides), [monthTx, setAsides]);
  const cats = useMemo(() => categoryTotals(monthTx), [monthTx]);
  const unknowns = useMemo(
    () => (detailsReady ? unknownMerchants(transactions) : []),
    [detailsReady, transactions],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matchesCategory = (t: Transaction) => {
      switch (categoryFilter) {
        case "all":
          return !isTransferTx(t);
        case "transfers":
          return isTransferTx(t);
        case "uncat":
          return !t.categoryId;
        default:
          return t.categoryId === categoryFilter;
      }
    };
    const matchesQuery = (t: Transaction) =>
      !q ||
      t.description.toLowerCase().includes(q) ||
      t.accountName.toLowerCase().includes(q) ||
      categoryName(t.categoryId).toLowerCase().includes(q);
    return monthTx.filter((t) => matchesCategory(t) && matchesQuery(t));
  }, [monthTx, query, categoryFilter]);

  const pagedUnknowns = useMemo(
    () => pageSlice(unknowns, merchantPage, MERCHANT_PAGE_SIZE),
    [unknowns, merchantPage],
  );
  const pagedTx = useMemo(() => pageSlice(filtered, txPage, TX_PAGE_SIZE), [filtered, txPage]);

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
            <p className="font-display text-xl font-medium tracking-tight italic sm:text-2xl">
              Omakei
            </p>
            <p className="hidden text-xs text-muted-foreground sm:block">
              {folder
                ? `Saved in ${folder.name}/omakei-ledger.json`
                : "Every statement, one ledger"}
            </p>
          </div>
          <div className="flex items-center gap-1 rounded-lg bg-card px-1 shadow-[var(--shadow-border)]">
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Previous month"
              disabled={!canPrev}
              onClick={() => setMonth(prevMonth)}
            >
              <ChevronLeft />
            </Button>
            <p className="min-w-32 text-center font-display text-sm font-medium sm:min-w-40 sm:text-base">
              {formatMonthLabel(selectedMonth)}
            </p>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Next month"
              disabled={!canNext}
              onClick={() => setMonth(nextMonth)}
            >
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
          <Button
            variant="outline"
            onClick={() => setImportOpen(true)}
            className="hidden sm:inline-flex"
          >
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
              <DropdownMenuItem onClick={() => setRulesOpen(true)}>
                Auto-categorize rules
              </DropdownMenuItem>
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
              {syncing
                ? "Syncing…"
                : folder
                  ? "No transactions yet"
                  : "Choose a folder of statements"}
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

        <PanelGrid
          ready={detailsReady}
          transactions={transactions}
          month={selectedMonth}
          monthTransactions={monthTx}
          setAsides={setAsides}
        />

        {detailsReady && unknowns.length > 0 ? (
          <NeedsCategoryPanel
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
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search merchants"
                  className="pl-9"
                  aria-label="Search transactions"
                />
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
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
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
            <p className="px-5 py-12 text-center text-sm text-muted-foreground">
              Nothing matches this month.
            </p>
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
        <p className="pb-20 text-center text-xs text-muted-foreground">
          Stored only on this device. Download the clean file anytime.
        </p>
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
            <AlertDialogDescription>
              Transactions on this device will be removed. Auto-categorize rules stay.
            </AlertDialogDescription>
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

/** Grid classes for the "Add" set-aside cell, so it fills the rest of its row
 *  at both the 2-column and 4-column breakpoints. */
function addSetAsideSpan(cellCount: number): string {
  const md = trailingCellSpan(cellCount, 4);
  return cn(trailingCellSpan(cellCount, 2) === 2 && "col-span-2", {
    "md:col-span-2": md === 2,
    "md:col-span-3": md === 3,
    "md:col-span-4": md === 4,
  });
}
