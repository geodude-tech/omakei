import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { saveLedgerNow } from "@/lib/finance/ledger-file";
import { useLedgerStore } from "@/lib/finance/store";
import {
  findSubscriptions,
  monthlyTotal,
  type Subscription,
  type SubscriptionFlag,
} from "@/lib/finance/subscriptions";
import type { Transaction } from "@/lib/finance/types";
import { formatDay, formatMoney, todayIso } from "@/lib/utils";

const CADENCE_LABEL = { weekly: "Weekly", monthly: "Monthly", yearly: "Yearly" } as const;

function flagLabel(flag: SubscriptionFlag): string {
  switch (flag.kind) {
    case "price-up":
      return `Up from ${formatMoney(flag.from ?? 0)}`;
    case "new":
      return "New";
    case "stopped":
      return "Seems to have stopped";
  }
}

function save() {
  void saveLedgerNow(useLedgerStore.getState());
}

/**
 * Recurring charges found in the ledger (docs/spec/subscriptions.md). A core
 * card, not a `src/panels/` panel, because it writes: "not a subscription" and
 * "dismiss" are stored in the ledger. Merchant names come straight off bank
 * statements, so they are only ever rendered as React text.
 */
export function SubscriptionsCard({ transactions }: { transactions: Transaction[] }) {
  const marks = useLedgerStore((s) => s.subscriptionMarks);
  const markSubscription = useLedgerStore((s) => s.markSubscription);
  const unmarkSubscription = useLedgerStore((s) => s.unmarkSubscription);
  const [showHidden, setShowHidden] = useState(false);

  const { subscriptions, hidden } = useMemo(
    () => findSubscriptions(transactions, { today: todayIso(), marks }),
    [transactions, marks],
  );

  if (subscriptions.length === 0 && hidden.length === 0) return null;

  const active = subscriptions.filter((s) => !s.stopped);
  const total = monthlyTotal(subscriptions);

  function notASubscription(sub: Subscription) {
    markSubscription(sub.key, "not-subscription", "");
    save();
    toast.message(`Hid ${sub.merchant}`, {
      action: {
        label: "Undo",
        onClick: () => {
          unmarkSubscription(sub.key, "not-subscription", "");
          save();
        },
      },
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recurring charges</CardTitle>
        <p className="text-sm text-muted-foreground">
          {active.length > 0 ? (
            <>
              About <span className="tabular-nums">{formatMoney(total)}</span> a month across{" "}
              {active.length} {active.length === 1 ? "charge" : "charges"}.
            </>
          ) : (
            "Nothing recurring right now."
          )}{" "}
          Found in your own transactions, on this device.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {subscriptions.map((sub) => (
          <div
            key={sub.key}
            className="flex flex-col gap-2 rounded-md bg-muted/50 px-3 py-3 sm:flex-row sm:items-center"
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{sub.merchant}</p>
              <p className="text-xs text-muted-foreground">
                {CADENCE_LABEL[sub.cadence]} ·{" "}
                <span className="tabular-nums">
                  {sub.variable ? "about " : ""}
                  {formatMoney(sub.typical)}
                </span>{" "}
                · last {formatDay(sub.lastDate)}
                {sub.stopped ? "" : ` · next ${formatDay(sub.nextDate)}`}
              </p>
              {sub.flags.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {sub.flags.map((flag) => (
                    <span
                      key={flag.kind}
                      className="inline-flex items-center gap-1 rounded-sm bg-background px-2 py-0.5 text-xs"
                    >
                      <span className={flag.kind === "price-up" ? "text-spend" : undefined}>
                        {flagLabel(flag)}
                      </span>
                      <button
                        type="button"
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={`Dismiss “${flagLabel(flag)}” for ${sub.merchant}`}
                        onClick={() => {
                          markSubscription(sub.key, flag.kind, flag.ref);
                          save();
                        }}
                      >
                        <X className="size-3" />
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            <p className="text-sm tabular-nums sm:w-28 sm:text-right">
              {formatMoney(sub.monthly)}
              <span className="text-xs text-muted-foreground"> /mo</span>
            </p>
            <Button variant="ghost" size="sm" onClick={() => notASubscription(sub)}>
              Not a subscription
            </Button>
          </div>
        ))}
        {hidden.length > 0 ? (
          <div className="flex flex-col gap-2 pt-1">
            <button
              type="button"
              className="self-start text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowHidden((v) => !v)}
            >
              {showHidden ? "Hide" : "Show"} {hidden.length} marked not a subscription
            </button>
            {showHidden
              ? hidden.map((sub) => (
                  <div key={sub.key} className="flex items-center gap-2 px-3 text-sm">
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">
                      {sub.merchant} · {formatMoney(sub.typical)}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        unmarkSubscription(sub.key, "not-subscription", "");
                        save();
                      }}
                    >
                      Restore
                    </Button>
                  </div>
                ))
              : null}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
