import assert from "node:assert/strict";
import { test } from "node:test";
import { HOUSING_CATEGORY, TRANSFER_CATEGORY } from "./categories.ts";
import { assignCategory, refreshCategories, seedRules } from "./ledger.ts";
import {
  applyTransferCategories,
  isInternalTransfer,
  mortgageCategory,
} from "./transfers.ts";
import type { Transaction } from "./types.ts";

function tx(
  partial: Partial<Transaction> &
    Pick<Transaction, "id" | "date" | "description" | "amount" | "accountKind">,
): Transaction {
  return {
    accountName: partial.accountName ?? partial.accountKind,
    sourceFile: "test.csv",
    fingerprint: `${partial.date}|${Math.round(partial.amount * 100)}`,
    categoryId: partial.categoryId ?? null,
    importedAt: 0,
    ...partial,
  };
}

test("checking mortgage payment is a transfer; mortgage posting is Housing", () => {
  assert.equal(isInternalTransfer("HOME LOAN PMT    CK-WTH        ACH", "checking"), true);
  assert.equal(isInternalTransfer("Regular Payment", "mortgage"), false);
  assert.equal(mortgageCategory("Mail"), HOUSING_CATEGORY);
  assert.equal(mortgageCategory("Regular Payment"), HOUSING_CATEGORY);
  assert.equal(mortgageCategory("Transfer from *9999 CK"), HOUSING_CATEGORY);
  assert.equal(mortgageCategory("Monthly Mortgage Payment"), HOUSING_CATEGORY);
  assert.equal(mortgageCategory("Escrow Tax Disbursement"), TRANSFER_CATEGORY);
  assert.equal(mortgageCategory("Principal Partial Payoff"), HOUSING_CATEGORY);
  assert.equal(mortgageCategory("Admin Reconveyance Fee"), "fees");
});

test("ATM deposits, FSA, brokerage, and account sweeps are not income", () => {
  assert.equal(
    isInternalTransfer("100 MAIN ST             ATM", "checking", 200),
    true,
  );
  assert.equal(
    isInternalTransfer("100 MAIN ST             ATM", "checking", -80),
    false,
  );
  assert.equal(isInternalTransfer("DEPOSIT", "checking", 185), true);
  assert.equal(isInternalTransfer("BENEFITS ADMIN   FLEXPTPDD     ACH", "checking"), true);
  assert.equal(isInternalTransfer("BROKERAGE FIRM   INVESTMENT    ACH", "checking"), true);
  assert.equal(isInternalTransfer("WWW FM    XXXX XX1111", "checking", 1000), true);
  assert.equal(isInternalTransfer("WWW TO    XXXX XX2222", "checking", -1000), true);
});

test("pairing keeps the mortgage payment as Housing, not a second transfer", () => {
  const rows = applyTransferCategories(
    [
      tx({
        id: "ck",
        date: "2026-08-03",
        description: "HOME LOAN PMT    CK-WTH        ACH",
        amount: -1800,
        accountKind: "checking",
      }),
      tx({
        id: "mtg",
        date: "2026-08-03",
        description: "Transfer from *9999 CK",
        amount: -1800,
        accountKind: "mortgage",
        categoryId: "transfers",
      }),
    ],
    [],
  );
  assert.equal(rows.find((r) => r.id === "ck")?.categoryId, TRANSFER_CATEGORY);
  assert.equal(rows.find((r) => r.id === "mtg")?.categoryId, HOUSING_CATEGORY);
});

test("same-bank WWW FM/TO pair is a transfer on both legs", () => {
  const rows = applyTransferCategories(
    [
      tx({
        id: "from",
        date: "2026-06-25",
        description: "WWW FM    XXXX XX1111",
        amount: 1000,
        accountKind: "checking",
        accountName: "1111",
      }),
      tx({
        id: "to",
        date: "2026-06-25",
        description: "WWW TO    XXXX XX2222",
        amount: -1000,
        accountKind: "checking",
        accountName: "2222",
      }),
    ],
    [],
  );
  assert.equal(rows.find((r) => r.id === "from")?.categoryId, TRANSFER_CATEGORY);
  assert.equal(rows.find((r) => r.id === "to")?.categoryId, TRANSFER_CATEGORY);
});

test("refreshCategories retags stale mortgage transfers and fills default merchants", () => {
  const rules = seedRules();
  const rows = refreshCategories(
    [
      tx({
        id: "mtg",
        date: "2026-07-01",
        description: "Regular Payment",
        amount: -1800,
        accountKind: "mortgage",
        categoryId: "transfers",
      }),
      tx({
        id: "grocer",
        date: "2026-08-10",
        description: "KROGER #70 SEATTLE WA",
        amount: -73.07,
        accountKind: "credit",
      }),
      tx({
        id: "atm",
        date: "2026-08-17",
        description: "100 MAIN ST             ATM",
        amount: 200,
        accountKind: "checking",
      }),
      tx({
        id: "wal",
        date: "2026-08-01",
        description: "WAL-MART #1001 SEATTLE WA",
        amount: -28.72,
        accountKind: "credit",
      }),
    ],
    rules,
  );
  const byId = Object.fromEntries(rows.map((r) => [r.id, r.categoryId]));
  assert.equal(byId.mtg, HOUSING_CATEGORY);
  assert.equal(byId.grocer, "groceries");
  assert.equal(byId.atm, TRANSFER_CATEGORY);
  assert.equal(byId.wal, "groceries");
});

test("sample-style mortgage payment is Housing even when the checking leg pairs", () => {
  const rules = seedRules();
  const rows = refreshCategories(
    [
      tx({
        id: "ck",
        date: "2026-05-01",
        description: "HOME LOAN PMT    CK-WTH        ACH",
        amount: -2847,
        accountKind: "checking",
      }),
      tx({
        id: "mtg",
        date: "2026-05-01",
        description: "Monthly Mortgage Payment",
        amount: -2847,
        accountKind: "mortgage",
      }),
    ],
    rules,
  );
  assert.equal(rows.find((r) => r.id === "ck")?.categoryId, TRANSFER_CATEGORY);
  assert.equal(rows.find((r) => r.id === "mtg")?.categoryId, HOUSING_CATEGORY);
});

test("payroll is never treated as a transfer", () => {
  assert.equal(
    isInternalTransfer("ACME CORP PAYROLL       ACH", "checking", 3240.18),
    false,
  );
});

test("safeway fuel, walmart, and dutch bros use the default categories", () => {
  const rules = seedRules();
  assert.equal(assignCategory("SAFEWAY FUEL1234 SEATTLE WA", rules), "transport");
  assert.equal(assignCategory("SAFEWAY #1234 SEATTLE WA", rules), "groceries");
  assert.equal(assignCategory("SAFEWAY #5678 PORTLAND OR", rules), "groceries");
  assert.equal(assignCategory("WALMART.COM 800-925-6278 AR", rules), "groceries");
  assert.equal(assignCategory("WAL-MART #1001 SEATTLE WA", rules), "groceries");
  assert.equal(assignCategory("DUTCH BROS SEATTLE WA", rules), "coffee");
});

test("longer identifier beats a shorter one (safeway fuel vs safeway)", () => {
  const rules = [
    {
      id: "u-store",
      pattern: "safeway",
      categoryId: "groceries",
      createdAt: 2,
      source: "user" as const,
    },
    {
      id: "u-fuel",
      pattern: "safeway fuel",
      categoryId: "transport",
      createdAt: 1,
      source: "user" as const,
    },
    ...seedRules(),
  ];
  assert.equal(assignCategory("SAFEWAY FUEL1234 SEATTLE WA", rules), "transport");
  assert.equal(assignCategory("SAFEWAY #5678 PORTLAND OR", rules), "groceries");
});
