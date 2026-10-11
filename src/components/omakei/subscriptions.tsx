import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { saveLedgerNow } from "@/lib/finance/ledger-file";
import { useLedgerStore } from "@/lib/finance/store";
import {
  findSubscriptions,
  SUBSCRIPTION_KINDS,
  type Subscription,
  type SubscriptionFlag,
  type SubscriptionKind,
} from "@/lib/finance/subscriptions";
import type { Transaction } from "@/lib/finance/types";
import { formatDay, formatMoney, todayIso } from "@/lib/utils";

const CADENCE_LABEL = {
  weekly: "Weekly",
  monthly: "Monthly",
  yearly: "Yearly",
  unknown: "No schedule yet",
} as const;

const HEADING: Record<SubscriptionKind, string> = {
  subscription: "Subscriptions",
  bill: "Bills",
  other: "Other recurring",
};

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

  const { subscriptions, hidden, totals } = useMemo(
    () => findSubscriptions(transactions, { today: todayIso(), marks }),
    [transactions, marks],
  );

  if (subscriptions.length === 0 && hidden.length === 0) return null;

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
          Found in your own transactions, on this device.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {SUBSCRIPTION_KINDS.map((kind) => {
          const rows = subscriptions.filter((s) => s.kind === kind);
          if (rows.length === 0) return null;
          const active = rows.filter((s) => !s.stopped && s.cadence !== "unknown").length;
          const unscheduled = rows.filter((s) => s.cadence === "unknown").length;
          return (
            <section key={kind} className="flex flex-col gap-2 pt-2 first:pt-0">
              <div className="flex items-baseline justify-between gap-2">
                <h3 className="text-sm font-medium">{HEADING[kind]}</h3>
                <p className="text-xs text-muted-foreground">
                  About <span className="tabular-nums">{formatMoney(totals[kind])}</span> a month
                  across {active}
                  {unscheduled > 0
                    ? `, plus ${unscheduled} with no schedule yet, not in the total`
                    : ""}
                </p>
              </div>
              {rows.map((sub) => (
                <div
                  key={sub.key}
                  className="flex flex-col gap-2 rounded-md bg-muted/50 px-3 py-3 sm:flex-row sm:items-center"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{sub.merchant}</p>
                    <p className="text-xs text-muted-foreground">
                      {CADENCE_LABEL[sub.cadence]}
                      {sub.confidence === "tagged" ? " (from your Subscriptions tag)" : ""} ·{" "}
                      <span className="tabular-nums">
                        {sub.variable ? "about " : ""}
                        {formatMoney(sub.typical)}
                      </span>{" "}
                      · last {formatDay(sub.lastDate)}
                      {sub.nextDate && !sub.stopped ? ` · next ${formatDay(sub.nextDate)}` : ""}
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
                    {sub.monthly === null ? (
                      <span className="text-xs text-muted-foreground">Not in total</span>
                    ) : (
                      <>
                        {formatMoney(sub.monthly)}
                        <span className="text-xs text-muted-foreground"> /mo</span>
                      </>
                    )}
                  </p>
                  <Button variant="ghost" size="sm" onClick={() => notASubscription(sub)}>
                    Not a subscription
                  </Button>
                </div>
              ))}
            </section>
          );
        })}
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
