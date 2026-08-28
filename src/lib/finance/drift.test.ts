import assert from "node:assert/strict";
import { test } from "node:test";
import { categoryDrift } from "./drift.ts";
import type { Transaction } from "./types.ts";

let seq = 0;
function tx(date: string, amount: number, categoryId: string | null): Transaction {
  seq += 1;
  return {
    id: `t${seq}`,
    date,
    description: "TEST",
    amount,
    accountName: "Credit Card",
    accountKind: "credit",
    sourceFile: "s.csv",
    fingerprint: `f${seq}`,
    categoryId,
    importedAt: seq,
  };
}

/** `amounts` runs oldest month first; the last entry is the month under test. */
function history(months: string[], amounts: number[], categoryId = "dining"): Transaction[] {
  return months.map((m, i) => tx(`${m}-05`, -amounts[i]!, categoryId));
}

const MONTHS = ["2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-07", "2026-08"];

test("a category above its average is reported with the percentage", () => {
  const rows = history(MONTHS, [100, 100, 100, 100, 100, 100, 200]);
  const [drift, ...rest] = categoryDrift(rows, "2026-08");
  assert.equal(rest.length, 0);
  assert.equal(drift?.name, "Dining");
  assert.equal(drift?.current, 200);
  assert.equal(drift?.average, 100);
  assert.equal(drift?.pct, 1);
  assert.equal(drift?.months, 6);
});

test("a steady category says nothing", () => {
  const rows = history(MONTHS, [100, 100, 100, 100, 100, 100, 105]);
  assert.deepEqual(categoryDrift(rows, "2026-08"), []);
});

test("a category below its average says nothing — this reports increases only", () => {
  const rows = history(MONTHS, [100, 100, 100, 100, 100, 100, 40]);
  assert.deepEqual(categoryDrift(rows, "2026-08"), []);
});

test("too little history is no trend", () => {
  const rows = history(["2026-06", "2026-07", "2026-08"], [100, 100, 400]);
  assert.deepEqual(categoryDrift(rows, "2026-08"), [], "two prior months is below minMonths");
  const enough = history(["2026-05", "2026-06", "2026-07", "2026-08"], [100, 100, 100, 400]);
  assert.equal(categoryDrift(enough, "2026-08").length, 1, "three prior months is enough");
});

test("a small baseline is ignored rather than reported as a huge percentage", () => {
  const rows = history(MONTHS, [3, 3, 3, 3, 3, 3, 30]);
  assert.deepEqual(categoryDrift(rows, "2026-08"), [], "900% on a $3 average is noise");
});

test("transfers and income never drift — they are not spending", () => {
  const cardPayments = history(MONTHS, [1500, 1500, 1500, 1500, 1500, 1500, 3000], "transfers");
  assert.deepEqual(categoryDrift(cardPayments, "2026-08"), []);
  const raises = MONTHS.map((m, i) => tx(`${m}-05`, i === 6 ? 8000 : 4000, "income"));
  assert.deepEqual(categoryDrift(raises, "2026-08"), []);
});

test("uncategorized spending drifts under Other", () => {
  const rows = history(MONTHS, [100, 100, 100, 100, 100, 100, 300], null);
  assert.equal(categoryDrift(rows, "2026-08")[0]?.name, "Other");
});

test("a month in progress is compared against the same days of earlier months", () => {
  // $100 by the 10th and $400 by month end, every month. On the 10th of August,
  // August's $100 is on pace, not down 75%.
  const rows: Transaction[] = [];
  for (const m of MONTHS) {
    rows.push(tx(`${m}-05`, -100, "dining"));
    if (m !== "2026-08") rows.push(tx(`${m}-20`, -300, "dining"));
  }
  assert.deepEqual(categoryDrift(rows, "2026-08", { today: "2026-08-10" }), []);

  // Double the month-to-date spend and it is a real increase on day 10.
  rows.push(tx("2026-08-06", -100, "dining"));
  const [drift] = categoryDrift(rows, "2026-08", { today: "2026-08-10" });
  assert.equal(drift?.current, 200);
  assert.equal(drift?.average, 100);
});

test("a past month is compared whole, whatever today is", () => {
  const rows: Transaction[] = [];
  for (const m of MONTHS) {
    rows.push(tx(`${m}-05`, -100, "dining"));
    rows.push(tx(`${m}-20`, m === "2026-07" ? -500 : -100, "dining"));
  }
  const [drift] = categoryDrift(rows, "2026-07", { today: "2026-08-03" });
  assert.equal(drift?.current, 600, "July is finished; the 3rd of August does not truncate it");
});

test("the biggest dollar increase is reported first", () => {
  const rows: Transaction[] = [];
  for (const m of MONTHS) {
    const last = m === "2026-08";
    rows.push(tx(`${m}-05`, last ? -1200 : -1000, "housing")); // +200, +20%
    rows.push(tx(`${m}-06`, last ? -180 : -100, "coffee")); //    +80, +80%
  }
  assert.deepEqual(
    categoryDrift(rows, "2026-08").map((d) => d.name),
    ["Housing", "Coffee"],
  );
});

test("an empty ledger is not a trend", () => {
  assert.deepEqual(categoryDrift([], "2026-08"), []);
});
