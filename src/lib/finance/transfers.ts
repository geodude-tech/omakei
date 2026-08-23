import { HOUSING_CATEGORY, TRANSFER_CATEGORY } from "./categories.ts";
import { ruleMatches } from "./fingerprint.ts";
import type { AccountKind, CategorizeRule, Transaction } from "./types.ts";

const CARD_PAYMENT =
  /payment thank you|thank you.?pmt|ba electronic payment|online\/mobile payment|online mobile payment|pmt received|payment received|autopay|auto pay|credit crd|credit card payment/;

const CHECKING_TO_CARD =
  /bank of america.{0,24}(payment|pmt|credit.?card|crd)|credit card (payment|pmt|autopay)|amex e-?payment|american express.{0,12}(payment|pmt)|discover.{0,12}(payment|pmt)|capital one.{0,12}(payment|pmt)/;

const CHECKING_TO_MORTGAGE =
  /mortgage (pmt|payment|loan)|home ?loan (pmt|payment)|ck-wth/;

const GENERIC_TRANSFER =
  /online transfer|transfer to |transfer from |wire (in|out)|internal transfer/;

const ACCOUNT_SWEEP = /www\s+(fm|to)\s+xxxx|\bxxxx\s+xx\d{4}\b/;
const ATM_REJECT = /atm dep reject|deposit reject/;
const BARE_DEPOSIT = /^(deposit|mobile deposit)$/;
const FSA = /flexptpdd|fsa (reimb|deposit|pmt)|flexible spending/;
const BROKERAGE = /\binvestment\s+ach\b/;
const ESCROW = /escrow|unapplied disbursement/;
const MORTGAGE_FEE = /admin|late charge|charge assessment|reamort|reconveyance/;
const MORTGAGE_PAYOFF = /payoff|principal/;
const MORTGAGE_PAYMENT =
  /^(mail|regular payment)$|monthly mortgage payment|regular payment/;
const MORTGAGE_PAYMENT_POSTING = /transfer from|xfer from/;

function norm(description: string): string {
  return description.toLowerCase().replace(/\s+/g, " ").trim();
}

export function isAtmDeposit(description: string, amount: number): boolean {
  if (amount <= 0) return false;
  const d = norm(description);
  return /\batm\b/.test(d) || BARE_DEPOSIT.test(d);
}

export function isCashMovement(description: string): boolean {
  const d = norm(description);
  return (
    ACCOUNT_SWEEP.test(d) ||
    ATM_REJECT.test(d) ||
    FSA.test(d) ||
    BROKERAGE.test(d)
  );
}

export function isInternalTransfer(
  description: string,
  accountKind: AccountKind,
  amount?: number,
): boolean {
  const d = norm(description);
  if (/payroll|salary|paycheck/.test(d)) return false;

  if (accountKind === "credit") return CARD_PAYMENT.test(d);

  if (accountKind === "checking" || accountKind === "savings") {
    if (/acctverify|account verify/.test(d)) return false;
    if (GENERIC_TRANSFER.test(d)) return true;
    if (CHECKING_TO_CARD.test(d) || CHECKING_TO_MORTGAGE.test(d)) return true;
    if (isCashMovement(description)) return true;
    if (amount !== undefined && isAtmDeposit(description, amount)) return true;
    return false;
  }

  if (accountKind === "mortgage") {
    return ESCROW.test(d);
  }

  return GENERIC_TRANSFER.test(d) && !/payroll|salary|paycheck/.test(d);
}

export function mortgageCategory(description: string): string | null {
  const d = norm(description);
  if (ESCROW.test(d)) return TRANSFER_CATEGORY;
  if (MORTGAGE_PAYOFF.test(d)) return HOUSING_CATEGORY;
  if (MORTGAGE_FEE.test(d)) return "fees";
  if (MORTGAGE_PAYMENT.test(d) || MORTGAGE_PAYMENT_POSTING.test(d)) {
    return HOUSING_CATEGORY;
  }
  return null;
}

function userLocked(description: string, rules: CategorizeRule[]): boolean {
  return rules.some((r) => r.source === "user" && ruleMatches(r.pattern, description));
}

function sameCents(a: number, b: number): boolean {
  return Math.round(Math.abs(a) * 100) === Math.round(Math.abs(b) * 100);
}

function daysApart(a: string, b: string): number {
  return Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;
}

function isPairableCredit(tx: Transaction): boolean {
  const d = norm(tx.description);
  return tx.accountKind === "credit" && (CARD_PAYMENT.test(d) || tx.amount > 0);
}

function isPairableMortgagePayment(tx: Transaction): boolean {
  return tx.accountKind === "mortgage" && mortgageCategory(tx.description) === HOUSING_CATEGORY;
}

function isBankAccount(tx: Transaction): boolean {
  return tx.accountKind === "checking" || tx.accountKind === "savings";
}

function isPairableBankLeg(tx: Transaction): boolean {
  if (!isBankAccount(tx)) return false;
  const d = norm(tx.description);
  return (
    ACCOUNT_SWEEP.test(d) ||
    GENERIC_TRANSFER.test(d) ||
    isAtmDeposit(tx.description, tx.amount) ||
    BARE_DEPOSIT.test(d)
  );
}

function patchCategories(
  transactions: Transaction[],
  updates: Map<string, string>,
): Transaction[] {
  if (updates.size === 0) return transactions;
  return transactions.map((t) => {
    const next = updates.get(t.id);
    return next ? { ...t, categoryId: next } : t;
  });
}

/** Checking card payment ↔ card credit; checking mortgage payment stays transfer, mortgage posting is Housing. */
export function pairInternalTransfers(
  transactions: Transaction[],
  rules: CategorizeRule[],
): Transaction[] {
  const updates = new Map<string, string>();
  const used = new Set<string>();
  const sources = transactions.filter((t) => isBankAccount(t) && t.amount < 0);
  const dests = transactions.filter((t) => isPairableCredit(t) || isPairableMortgagePayment(t));

  for (const src of sources) {
    if (userLocked(src.description, rules)) continue;
    const cents = Math.round(Math.abs(src.amount) * 100);
    if (cents < 100) continue;
    let best: Transaction | null = null;
    let bestDays = Infinity;
    for (const dest of dests) {
      if (used.has(dest.id) || dest.id === src.id) continue;
      if (userLocked(dest.description, rules)) continue;
      if (!sameCents(src.amount, dest.amount)) continue;
      const days = daysApart(src.date, dest.date);
      if (days > 5) continue;
      if (days < bestDays) {
        best = dest;
        bestDays = days;
      }
    }
    if (!best) continue;
    used.add(best.id);
    updates.set(src.id, TRANSFER_CATEGORY);
    updates.set(
      best.id,
      best.accountKind === "mortgage" ? HOUSING_CATEGORY : TRANSFER_CATEGORY,
    );
  }

  return patchCategories(transactions, updates);
}

/** Opposite-sign same-dollar moves between checking/savings (WWW FM/TO, ATM, online transfer). */
export function pairSameBankMoves(
  transactions: Transaction[],
  rules: CategorizeRule[],
): Transaction[] {
  const updates = new Map<string, string>();
  const used = new Set<string>();
  const legs = transactions.filter(isPairableBankLeg);

  for (let i = 0; i < legs.length; i++) {
    const a = legs[i]!;
    if (used.has(a.id) || userLocked(a.description, rules)) continue;
    const cents = Math.round(Math.abs(a.amount) * 100);
    if (cents < 100) continue;
    let best: Transaction | null = null;
    let bestDays = Infinity;
    for (let j = 0; j < legs.length; j++) {
      const b = legs[j]!;
      if (a.id === b.id || used.has(b.id)) continue;
      if (userLocked(b.description, rules)) continue;
      if (a.accountName === b.accountName) continue;
      if (Math.sign(a.amount) === Math.sign(b.amount)) continue;
      if (!sameCents(a.amount, b.amount)) continue;
      const days = daysApart(a.date, b.date);
      if (days > 3) continue;
      if (days < bestDays) {
        best = b;
        bestDays = days;
      }
    }
    if (!best) continue;
    used.add(a.id);
    used.add(best.id);
    updates.set(a.id, TRANSFER_CATEGORY);
    updates.set(best.id, TRANSFER_CATEGORY);
  }

  return patchCategories(transactions, updates);
}

export function applyTransferCategories(
  transactions: Transaction[],
  rules: CategorizeRule[],
): Transaction[] {
  const tagged = transactions.map((tx) => {
    if (userLocked(tx.description, rules)) return tx;
    if (isInternalTransfer(tx.description, tx.accountKind, tx.amount)) {
      return { ...tx, categoryId: TRANSFER_CATEGORY };
    }
    if (tx.accountKind === "mortgage") {
      const housing = mortgageCategory(tx.description);
      if (housing) return { ...tx, categoryId: housing };
    }
    return tx;
  });
  return pairSameBankMoves(pairInternalTransfers(tagged, rules), rules);
}

export function isTransferTx(tx: { categoryId: string | null }): boolean {
  return tx.categoryId === TRANSFER_CATEGORY;
}
