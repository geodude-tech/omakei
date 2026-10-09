import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findSubscriptions,
  monthlyTotal,
  nextDateAfter,
  parseSubscriptionMarks,
  subscriptionKey,
  type SubscriptionMark,
} from "./subscriptions.ts";
import type { Transaction } from "./types.ts";

let seq = 0;
function tx(
  date: string,
  amount: number,
  description: string,
  categoryId: string | null = null,
): Transaction {
  seq += 1;
  return {
    id: `t${seq}`,
    date,
    description,
    amount,
    accountName: "Credit Card",
    accountKind: "credit",
    sourceFile: "s.csv",
    fingerprint: `f${seq}`,
    categoryId,
    importedAt: seq,
  };
}

/** `count` charges, `stepMonths` apart, on `day`, starting at `start` ("YYYY-MM"). */
function monthly(
  start: string,
  count: number,
  amount: number | number[],
  description: string | ((i: number) => string),
  day = 5,
  stepMonths = 1,
): Transaction[] {
  const [y, m] = start.split("-").map(Number) as [number, number];
  const out: Transaction[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(Date.UTC(y, m - 1 + i * stepMonths, day));
    const iso = d.toISOString().slice(0, 10);
    const amt = Array.isArray(amount) ? amount[i]! : amount;
    out.push(tx(iso, -amt, typeof description === "function" ? description(i) : description));
  }
  return out;
}

function everyDays(
  start: string,
  count: number,
  days: number,
  amount: number | ((i: number) => number),
  description: string,
  categoryId: string | null = null,
): Transaction[] {
  const base = Date.parse(`${start}T00:00:00Z`);
  return Array.from({ length: count }, (_, i) =>
    tx(
      new Date(base + i * days * 86400000).toISOString().slice(0, 10),
      -(typeof amount === "function" ? amount(i) : amount),
      description,
      categoryId,
    ),
  );
}

/** Something on the last day so "as of" is fixed by the data, not the clock. */
const ANCHOR = tx("2026-09-30", -1, "ANCHOR ONE OFF");

test("a monthly charge is found with cadence, amounts, dates and monthly cost", () => {
  const rows = [...monthly("2026-01", 9, 15.49, "NETFLIX.COM 866-579-7172 CA"), ANCHOR];
  const { subscriptions } = findSubscriptions(rows, { today: "2026-09-30" });
  assert.equal(subscriptions.length, 1);
  const s = subscriptions[0]!;
  assert.equal(s.key, "netflix");
  assert.equal(s.cadence, "monthly");
  assert.equal(s.typical, 15.49);
  assert.equal(s.monthly, 15.49);
  assert.equal(s.lastDate, "2026-09-05");
  assert.equal(s.nextDate, "2026-10-05");
  assert.equal(s.count, 9);
  assert.equal(s.stopped, false);
  assert.deepEqual(s.flags, []);
});

test("a yearly charge is found and costs a twelfth a month", () => {
  const rows = [...monthly("2024-03", 3, 120, "NAMECHEAP.COM RENEWAL", 12, 12), ANCHOR];
  const [s] = findSubscriptions(rows, { today: "2026-09-30" }).subscriptions;
  assert.equal(s?.cadence, "yearly");
  assert.equal(s?.monthly, 10);
  assert.equal(s?.nextDate, "2027-03-12");
});

test("a weekly charge is found and costs 52/12 of it a month", () => {
  const rows = [...everyDays("2026-08-04", 8, 7, 6, "PATREON MEMBERSHIP"), ANCHOR];
  const [s] = findSubscriptions(rows, { today: "2026-09-30" }).subscriptions;
  assert.equal(s?.cadence, "weekly");
  assert.equal(s?.monthly, 26);
  assert.equal(s?.nextDate, "2026-09-29");
});

test("a price rise is flagged with what it used to cost, then ages out", () => {
  const hike = [10.99, 10.99, 10.99, 10.99, 10.99, 10.99, 13.99, 13.99];
  const rows = [...monthly("2026-02", 8, hike, "SPOTIFY USA"), ANCHOR];
  const [s] = findSubscriptions(rows, { today: "2026-09-30" }).subscriptions;
  assert.equal(s?.variable, false, "one step up is still a fixed price");
  assert.equal(s?.typical, 13.99);
  assert.deepEqual(s?.flags, [{ kind: "price-up", ref: "1399", from: 10.99 }]);

  const later = [
    ...monthly("2026-02", 12, [...hike, 13.99, 13.99, 13.99, 13.99], "SPOTIFY USA"),
    tx("2027-01-30", -1, "ANCHOR"),
  ];
  const [aged] = findSubscriptions(later, { today: "2027-01-30" }).subscriptions;
  assert.deepEqual(aged?.flags, [], "after a few months at the new price it is just the price");
});

test("a small wobble is not a price rise", () => {
  const rows = [
    ...monthly("2026-02", 8, [50, 50, 50, 50, 50, 50, 50, 50.3], "CITY WATER UTIL"),
    ANCHOR,
  ];
  const [s] = findSubscriptions(rows, { today: "2026-09-30" }).subscriptions;
  assert.deepEqual(s?.flags, []);
});

test("a new subscription is flagged new", () => {
  const rows = [...monthly("2026-07", 3, 9.99, "DISNEY PLUS"), ANCHOR];
  const [s] = findSubscriptions(rows, { today: "2026-09-30" }).subscriptions;
  assert.deepEqual(s?.flags, [{ kind: "new", ref: "2026-07-05" }]);
});

test("one that has not charged for a while is flagged stopped and listed last", () => {
  const rows = [
    ...monthly("2026-02", 6, 30, "PLANET FITNESS"), // last 2026-07-05
    ...monthly("2026-01", 9, 5, "ICLOUD STORAGE"),
    ANCHOR,
  ];
  const { subscriptions } = findSubscriptions(rows, { today: "2026-09-30" });
  assert.deepEqual(
    subscriptions.map((s) => s.key),
    ["icloud", "planet"],
  );
  const gym = subscriptions[1]!;
  assert.equal(gym.stopped, true);
  assert.deepEqual(gym.flags, [{ kind: "stopped", ref: "2026-07-05" }]);
  assert.equal(monthlyTotal(subscriptions), 5, "a stopped one is not in the monthly total");
});

test("one stopped long ago is history and not listed", () => {
  const rows = [...monthly("2025-01", 6, 30, "PLANET FITNESS"), ANCHOR]; // last 2025-06-05
  assert.deepEqual(findSubscriptions(rows, { today: "2026-09-30" }).subscriptions, []);
});

test("as-of is the latest transaction, so stale statements do not look stopped", () => {
  const rows = monthly("2026-01", 6, 15.49, "NETFLIX.COM"); // last 2026-06-05, nothing after
  const { subscriptions, asOf } = findSubscriptions(rows, { today: "2026-10-08" });
  assert.equal(asOf, "2026-06-05");
  assert.equal(subscriptions[0]?.stopped, false);
});

test("noisy descriptions of one merchant land on one key", () => {
  const noise = [
    "NETFLIX.COM 866-579-7172 CA",
    "NETFLIX.COM NETFLIX.COM CA 01/05",
    "CHECKCARD 0305 NETFLIX.COM 866-5797172 CA XXXX1234",
    "NETFLIX INC #12345",
    "POS DEBIT NETFLIX.COM 05/05 CARD 9876",
    "Netflix.com *4421",
  ];
  const rows = [...monthly("2026-04", 6, 15.49, (i) => noise[i]!), ANCHOR];
  const { subscriptions } = findSubscriptions(rows, { today: "2026-09-30" });
  assert.equal(subscriptions.length, 1, JSON.stringify(noise.map(subscriptionKey)));
  assert.equal(subscriptions[0]?.count, 6);
});

test("subscriptionKey strips dates, card masks, store numbers, and web suffixes", () => {
  assert.equal(subscriptionKey("SPOTIFY USA 10/05 PURCHASE"), subscriptionKey("SPOTIFY USA"));
  assert.equal(subscriptionKey("HULU 877-8244858 CA XXXX1234"), "hulu");
  assert.equal(subscriptionKey("www.audible.com"), subscriptionKey("AUDIBLE"));
  assert.equal(
    subscriptionKey("PLANET FITNESS #0421 2026-03-01"),
    subscriptionKey("PLANET FITNESS"),
  );
  assert.equal(subscriptionKey("PLANET FITNESS #0421 2026-03-01"), "planet");
});

test("two plans at one merchant are two subscriptions", () => {
  const small = monthly("2026-01", 9, 0.99, "APPLE.COM/BILL 866-712-7753 CA", 3);
  const big = monthly("2026-01", 9, 10.99, "APPLE.COM/BILL 866-712-7753 CA", 18);
  const { subscriptions } = findSubscriptions([...small, ...big, ANCHOR], { today: "2026-09-30" });
  assert.deepEqual(
    subscriptions.map((s) => s.typical),
    [10.99, 0.99],
  );
  assert.notEqual(subscriptions[0]!.key, subscriptions[1]!.key);
});

test("a monthly bill that varies is found and marked variable, with no price flag", () => {
  const amounts = [142.1, 98.4, 87.2, 120.55, 160.3, 190.75, 175.2, 110.9];
  const rows = [...monthly("2026-02", 8, amounts, "PG&E WEB ONLINE"), ANCHOR];
  const [s] = findSubscriptions(rows, { today: "2026-09-30" }).subscriptions;
  assert.equal(s?.variable, true);
  assert.equal(s?.cadence, "monthly");
  assert.deepEqual(s?.flags, []);
});

test("groceries, dining and coffee are not subscriptions, even on a schedule", () => {
  const rows = [
    ...everyDays("2026-06-06", 16, 7, (i) => 80 + (i % 5) * 23, "SAFEWAY #1234", "groceries"),
    ...everyDays("2026-06-01", 16, 7, 4.5, "BLUE BOTTLE COFFEE", "coffee"),
    ANCHOR,
  ];
  assert.deepEqual(findSubscriptions(rows, { today: "2026-09-30" }).subscriptions, []);
});

test("an uncategorized store visited irregularly is not a subscription", () => {
  const dates = [
    "2026-06-02",
    "2026-06-09",
    "2026-06-21",
    "2026-07-03",
    "2026-07-05",
    "2026-07-30",
    "2026-08-11",
    "2026-09-02",
    "2026-09-04",
  ];
  const rows = [
    ...dates.map((d, i) => tx(d, -(25 + i * 7), "TARGET 00012345 SAN JOSE CA")),
    ANCHOR,
  ];
  assert.deepEqual(findSubscriptions(rows, { today: "2026-09-30" }).subscriptions, []);
});

test("a weekly shop with changing totals is not a subscription", () => {
  const rows = [
    ...everyDays("2026-06-06", 16, 7, (i) => 60 + ((i * 37) % 11) * 9.17, "COSTCO WHSE #0423"),
    ANCHOR,
  ];
  assert.deepEqual(findSubscriptions(rows, { today: "2026-09-30" }).subscriptions, []);
});

test("two charges a month apart are not enough to call it monthly", () => {
  const rows = [...monthly("2026-08", 2, 20, "SOME SHOP"), ANCHOR];
  assert.deepEqual(findSubscriptions(rows, { today: "2026-09-30" }).subscriptions, []);
});

test("transfers, checks, ATM cash and refunds are ignored", () => {
  const rows = [
    ...monthly("2026-01", 9, 1500, "ONLINE TRANSFER TO SAVINGS").map((t) => ({
      ...t,
      categoryId: "transfers",
    })),
    ...monthly("2026-01", 9, 200, "CHECK"),
    ...monthly("2026-01", 9, 100, "BKOFAMERICA ATM WITHDRWL"),
    ...monthly("2026-01", 9, 15, "NETFLIX REFUND").map((t) => ({ ...t, amount: 15 })),
    ANCHOR,
  ];
  assert.deepEqual(findSubscriptions(rows, { today: "2026-09-30" }).subscriptions, []);
});

test("not-a-subscription hides it; dismissing a flag hides only that occurrence", () => {
  const rows = [
    ...monthly("2026-07", 3, 9.99, "DISNEY PLUS"),
    ...monthly("2026-01", 9, 5, "ICLOUD STORAGE"),
    ANCHOR,
  ];
  const marks: SubscriptionMark[] = [
    { key: "icloud", kind: "not-subscription", ref: "", createdAt: 1 },
    { key: "disney", kind: "new", ref: "2026-07-05", createdAt: 1 },
  ];
  const { subscriptions, hidden } = findSubscriptions(rows, { today: "2026-09-30", marks });
  assert.deepEqual(
    subscriptions.map((s) => s.key),
    ["disney"],
  );
  assert.deepEqual(subscriptions[0]!.flags, []);
  assert.deepEqual(
    hidden.map((s) => s.key),
    ["icloud"],
  );

  const stale: SubscriptionMark[] = [
    { key: "disney", kind: "new", ref: "2025-01-05", createdAt: 1 },
  ];
  const again = findSubscriptions(rows, { today: "2026-09-30", marks: stale }).subscriptions;
  assert.equal(
    again[0]!.flags.length,
    1,
    "a dismissal of another occurrence does not hide this one",
  );
});

test("a dismissed price rise comes back when the price rises again", () => {
  const first = [
    ...monthly("2026-01", 8, [10, 10, 10, 10, 10, 10, 10, 12], "SPOTIFY USA"),
    tx("2026-08-30", -1, "A"),
  ];
  const [s] = findSubscriptions(first, { today: "2026-08-30" }).subscriptions;
  const marks: SubscriptionMark[] = [
    { key: s!.key, kind: "price-up", ref: s!.flags[0]!.ref, createdAt: 1 },
  ];
  assert.deepEqual(
    findSubscriptions(first, { today: "2026-08-30", marks }).subscriptions[0]!.flags,
    [],
  );
  const second = [
    ...monthly("2026-01", 9, [10, 10, 10, 10, 10, 10, 10, 12, 15], "SPOTIFY USA"),
    tx("2026-09-30", -1, "A"),
  ];
  const flags = findSubscriptions(second, { today: "2026-09-30", marks }).subscriptions[0]!.flags;
  assert.equal(flags[0]?.kind, "price-up");
  assert.equal(flags[0]?.ref, "1500");
});

test("an empty ledger finds nothing", () => {
  assert.deepEqual(findSubscriptions([]), { subscriptions: [], hidden: [], asOf: "" });
});

test("malformed rows are skipped, not thrown on", () => {
  const junk = [
    null,
    { date: 5 },
    { date: "2026-01-01", amount: "x", description: "A" },
  ] as unknown as Transaction[];
  assert.doesNotThrow(() => findSubscriptions([...junk, ANCHOR]));
});

test("nextDateAfter clamps to month end and rolls years", () => {
  assert.equal(nextDateAfter("2026-01-31", "monthly"), "2026-02-28");
  assert.equal(nextDateAfter("2026-12-15", "monthly"), "2027-01-15");
  assert.equal(nextDateAfter("2024-02-29", "yearly"), "2025-02-28");
  assert.equal(nextDateAfter("2026-12-29", "weekly"), "2027-01-05");
});

test("parseSubscriptionMarks keeps good marks and drops bad ones", () => {
  const parsed = parseSubscriptionMarks([
    { key: "netflix", kind: "not-subscription", ref: "", createdAt: 5 },
    { key: "hulu", kind: "price-up", ref: "1299" },
    { key: "x", kind: "delete-everything", ref: "" },
    { key: "", kind: "new", ref: "" },
    { key: "y".repeat(201), kind: "new", ref: "" },
    { key: "z", kind: "new", ref: "r".repeat(41) },
    "nope",
  ]);
  assert.deepEqual(parsed, [
    { key: "netflix", kind: "not-subscription", ref: "", createdAt: 5 },
    { key: "hulu", kind: "price-up", ref: "1299", createdAt: 0 },
  ]);
  assert.deepEqual(parseSubscriptionMarks(undefined), []);
});
