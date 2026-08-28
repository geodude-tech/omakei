import { useEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import { parseMoneyInput } from "@/lib/finance/set-asides";
import type { SetAside } from "@/lib/finance/types";
import { cn, formatMoney } from "@/lib/utils";

export function SetAsideStat({
  item,
  autoFocus,
  onChange,
  onCommit,
  onRemove,
}: {
  item: SetAside;
  autoFocus?: boolean;
  onChange: (patch: { name?: string; amount?: number }) => void;
  onCommit?: () => void;
  onRemove: () => void;
}) {
  const nameRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const [editingAmount, setEditingAmount] = useState(false);
  const [amountDraft, setAmountDraft] = useState("");
  const editingAmountRef = useRef(false);
  const amountDraftRef = useRef("");
  const itemAmountRef = useRef(item.amount);
  const onChangeRef = useRef(onChange);
  const onCommitRef = useRef(onCommit);
  editingAmountRef.current = editingAmount;
  amountDraftRef.current = amountDraft;
  itemAmountRef.current = item.amount;
  onChangeRef.current = onChange;
  onCommitRef.current = onCommit;

  useEffect(() => {
    if (!autoFocus) return;
    nameRef.current?.focus();
    nameRef.current?.select();
  }, [autoFocus]);

  function startAmountEdit() {
    setAmountDraft(item.amount === 0 ? "" : String(item.amount));
    setEditingAmount(true);
    requestAnimationFrame(() => {
      amountRef.current?.focus();
      amountRef.current?.select();
    });
  }

  function commitAmount() {
    const parsed = parseMoneyInput(amountDraft);
    if (parsed !== null) onChange({ amount: parsed });
    setEditingAmount(false);
    onCommit?.();
  }

  useEffect(() => {
    function commitInFlight(event: Event) {
      if (event.type === "visibilitychange" && document.visibilityState !== "hidden") return;
      if (!editingAmountRef.current) return;
      const parsed = parseMoneyInput(amountDraftRef.current);
      if (parsed !== null && parsed !== itemAmountRef.current) {
        onChangeRef.current({ amount: parsed });
      }
      onCommitRef.current?.();
    }
    document.addEventListener("visibilitychange", commitInFlight, true);
    window.addEventListener("pagehide", commitInFlight, true);
    return () => {
      document.removeEventListener("visibilitychange", commitInFlight, true);
      window.removeEventListener("pagehide", commitInFlight, true);
    };
  }, []);

  return (
    <div className="relative bg-muted px-4 py-4 sm:px-5" data-stat="set-aside">
      <input
        ref={nameRef}
        value={item.name}
        onChange={(e) => onChange({ name: e.target.value })}
        onBlur={() => {
          onChange({ name: item.name.trim() });
          onCommit?.();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            startAmountEdit();
          }
        }}
        placeholder="Taxes"
        aria-label="Set-aside name"
        className="w-full bg-transparent text-xs font-medium tracking-wide text-muted-foreground uppercase outline-none placeholder:normal-case placeholder:tracking-normal"
      />
      {editingAmount ? (
        <input
          ref={amountRef}
          value={amountDraft}
          onChange={(e) => setAmountDraft(e.target.value)}
          onBlur={commitAmount}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commitAmount();
            }
            if (e.key === "Escape") {
              setEditingAmount(false);
            }
          }}
          inputMode="decimal"
          aria-label={`${item.name || "Set aside each month"} amount`}
          className="mt-1 w-full bg-transparent font-display text-2xl font-medium tracking-tight text-reserved tabular-nums outline-none sm:text-3xl"
        />
      ) : (
        <button
          type="button"
          onClick={startAmountEdit}
          className="mt-1 block w-full text-left font-display text-2xl font-medium tracking-tight text-reserved tabular-nums sm:text-3xl"
          aria-label={`${item.name || "Set aside each month"} amount ${formatMoney(item.amount)}. Edit`}
        >
          {formatMoney(item.amount)}
        </button>
      )}
      <p className="mt-1 text-xs text-reserved/80">each month</p>
      <button
        type="button"
        onClick={onRemove}
        title="Remove set-aside"
        aria-label={`Remove ${item.name || "set-aside"}`}
        className="absolute top-2 right-2 rounded-sm p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

export function AddSetAsideCell({
  onClick,
  className,
}: {
  onClick: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-stat="add-set-aside"
      className={cn(
        "flex flex-col items-start bg-muted px-4 py-4 text-left sm:px-5 hover:bg-muted/80",
        className,
      )}
    >
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Each month</p>
      <p className="mt-1 flex items-center gap-2 font-display text-2xl font-medium tracking-tight text-muted-foreground sm:text-3xl">
        <Plus className="size-6" />
        Add
      </p>
    </button>
  );
}
