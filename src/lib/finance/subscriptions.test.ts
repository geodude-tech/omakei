import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findSubscriptions,
  nextDateAfter,
  parseSubscriptionMarks,
  subscriptionKey,
  type Subscription,
  type SubscriptionMark,
} from "./subscriptions.ts";
import { defaultRules } from "./categories.ts";
import { mergeImport } from "./ledger.ts";
import { parseStatementAtPath } from "./statements.ts";
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
  const { subscriptions, totals } = findSubscriptions(rows, { today: "2026-09-30" });
  assert.deepEqual(
    subscriptions.map((s) => s.key),
    ["icloud", "planet"],
  );
  const gym = subscriptions[1]!;
  assert.equal(gym.stopped, true);
  assert.deepEqual(gym.flags, [{ kind: "stopped", ref: "2026-07-05" }]);
  assert.deepEqual(
    totals,
    { subscription: 0, bill: 0, other: 5 },
    "a stopped one is not in the total",
  );
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
  const rows = [
    ...monthly("2026-02", 8, amounts, "PG&E WEB ONLINE").map((t) => ({
      ...t,
      categoryId: "utilities",
    })),
    ANCHOR,
  ];
  const [s] = findSubscriptions(rows, { today: "2026-09-30" }).subscriptions;
  assert.equal(s?.variable, true);
  assert.equal(s?.cadence, "monthly");
  assert.equal(s?.typical, 175.2, "a bill that varies costs the median of its last three");
  assert.equal(s?.kind, "bill");
  assert.deepEqual(s?.flags, []);
});

test("a regular visit whose bill changes is not a bill unless it is a bill category", () => {
  // A salon booked about monthly is regular, and the total changes each time.
  const amounts = [180, 240.5, 195, 260, 210.75, 230];
  const salon = monthly("2026-03", 6, amounts, "VAGARO_*SALON").map((t) => ({
    ...t,
    categoryId: "personal-care",
  }));
  assert.deepEqual(
    findSubscriptions([...salon, ANCHOR], { today: "2026-09-30" }).subscriptions,
    [],
  );
  const uncategorized = monthly("2026-03", 6, amounts, "VAGARO_*SALON");
  assert.deepEqual(
    findSubscriptions([...uncategorized, ANCHOR], { today: "2026-09-30" }).subscriptions,
    [],
  );
});

test("a bill that wanders by a few dollars is never a price rise", () => {
  const amounts = [137.29, 140.1, 135.5, 139.0, 137.3, 145.0];
  const rows = [...monthly("2026-04", 6, amounts, "INLAND WATER DIST"), ANCHOR];
  const [s] = findSubscriptions(rows, { today: "2026-09-30" }).subscriptions;
  assert.equal(s?.variable, false);
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
    ...monthly("2026-01", 9, [10, 10, 10, 10, 10, 10, 12, 12, 15], "SPOTIFY USA"),
    tx("2026-09-30", -1, "A"),
  ];
  const flags = findSubscriptions(second, { today: "2026-09-30", marks }).subscriptions[0]!.flags;
  assert.equal(flags[0]?.kind, "price-up");
  assert.equal(flags[0]?.ref, "1500");
});

test("an empty ledger finds nothing", () => {
  assert.deepEqual(findSubscriptions([]), {
    subscriptions: [],
    hidden: [],
    totals: { subscription: 0, bill: 0, other: 0 },
    total: 0,
    asOf: "",
  });
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

const TAG = "subscriptions";

function tagged(date: string, amount: number, description: string): Transaction {
  return tx(date, -amount, description, TAG);
}

function brief(s: Subscription) {
  return {
    key: s.key,
    cadence: s.cadence,
    typical: s.typical,
    count: s.count,
    firstDate: s.firstDate,
    lastDate: s.lastDate,
    stopped: s.stopped,
    confidence: s.confidence,
    monthly: s.monthly,
  };
}

test("a plan whose bank line changes shape mid-series stays one subscription", () => {
  const rows = [
    tagged("2026-05-17", 11.47, "ZORPFLIX 800-555-0100 CA"),
    tagged("2026-06-17", 11.47, "ZORPFLIX 800-555-0100 CA"),
    tagged("2026-07-17", 11.48, "ZFX*ZORPFLIXPLUS zorpflix.com/billCA"),
    tagged("2026-08-17", 11.48, "Zorpflix"),
    tagged("2026-09-17", 11.48, "Zorpflix"),
    ANCHOR,
  ];
  const { subscriptions } = findSubscriptions(rows, { today: "2026-09-30" });
  assert.deepEqual(subscriptions.map(brief), [
    {
      key: "zorpflix",
      cadence: "monthly",
      typical: 11.48,
      count: 5,
      firstDate: "2026-05-17",
      lastDate: "2026-09-17",
      stopped: false,
      confidence: "schedule",
      monthly: 11.48,
    },
  ]);
  assert.equal(subscriptions[0]!.merchant, "Zorpflix");
});

test("a processor prefix and a help URL key on the domain, not the first word", () => {
  assert.equal(subscriptionKey("ZFX*ZORPFLIXPLUS zorpflix.com/billCA"), "zorpflix");
  assert.equal(subscriptionKey("BLORPIFY *Blorpify Drive b.co/paysupport#CA"), "blorpify");
  assert.equal(subscriptionKey("B9QX771K b.co/paysupport#CA"), "b");
  assert.equal(subscriptionKey("4410 ZAPP.COM/BILL FTM"), "zapp");
  assert.equal(subscriptionKey("ZAPP.COM/BILL 800-555-0199 CA"), "zapp");
  assert.equal(subscriptionKey("pay.quux.com 800-555-0123"), "quux");
});

test("a plan billed through a short-link domain is one row under its brand", () => {
  const rows = [
    tagged("2026-05-11", 3.25, "BLORPIFY *Blorpify Drive b.co/paysupport#CA"),
    tagged("2026-06-11", 3.25, "B9QX771K b.co/paysupport#CA"),
    tagged("2026-07-11", 3.25, "Blorpify Drive"),
    tagged("2026-08-11", 3.25, "Blorpify Drive"),
    tagged("2026-09-11", 3.25, "Q4ZR208T b.co/paysupport#CA"),
    ANCHOR,
  ];
  const { subscriptions, totals } = findSubscriptions(rows, { today: "2026-09-30" });
  assert.deepEqual(subscriptions.map(brief), [
    {
      key: "blorpify",
      cadence: "monthly",
      typical: 3.25,
      count: 5,
      firstDate: "2026-05-11",
      lastDate: "2026-09-11",
      stopped: false,
      confidence: "schedule",
      monthly: 3.25,
    },
  ]);
  assert.equal(subscriptions[0]!.merchant, "Blorpify");
  assert.deepEqual(totals, { subscription: 3.25, bill: 0, other: 0 });
});

test("a short-link code line shared by two brands stays on its own", () => {
  const rows = [
    ...["05", "06", "07"].map((m) => tagged(`2026-${m}-11`, 3.25, "Blorpify Drive b.co/pay#CA")),
    ...["05", "06", "07"].map((m) => tagged(`2026-${m}-20`, 8.1, "Zorptube b.co/pay#CA")),
    tagged("2026-08-11", 3.25, "B9QX771K b.co/pay#CA"),
    ANCHOR,
  ];
  const { subscriptions } = findSubscriptions(rows, { today: "2026-09-30" });
  assert.deepEqual(subscriptions.map((s) => s.key).sort(), ["b", "blorpify", "zorptube"]);
});

test("a monthly charge with one month missing is still monthly", () => {
  const rows = [
    ...["05", "06", "08", "09"].map((m) => tx(`2026-${m}-14`, -9.5, "QUUXCLOUD STORAGE")),
    ANCHOR,
  ];
  const { subscriptions } = findSubscriptions(rows, { today: "2026-09-30" });
  assert.deepEqual(subscriptions.map(brief), [
    {
      key: "quuxcloud",
      cadence: "monthly",
      typical: 9.5,
      count: 4,
      firstDate: "2026-05-14",
      lastDate: "2026-09-14",
      stopped: false,
      confidence: "schedule",
      monthly: 9.5,
    },
  ]);
});

test("every tagged plan at an app store is listed, however few its charges", () => {
  const lines = ["ZAPP.COM/BILL", "4410 ZAPP.COM/BILL FTM", "ZAPP.COM/BILL 800-555-0199 CA"];
  const at = (i: number) => lines[i % lines.length]!;
  const rows = [
    ...["2025-07", "2025-08", "2025-09", "2025-10", "2025-11", "2025-12"].map((m, i) =>
      tagged(`${m}-08`, 1.49, at(i)),
    ),
    ...["01", "02", "03", "04", "05", "06", "07", "08"].map((m, i) =>
      tagged(`2026-${m}-22`, 6.2, at(i)),
    ),
    tagged("2026-02-06", 42.05, at(0)),
    tagged("2026-03-09", 12.3, at(1)),
    tagged("2026-08-27", 41.1, at(0)),
    tagged("2026-09-27", 41.1, at(1)),
    tagged("2026-09-26", 8.4, at(2)),
  ];
  const { subscriptions, totals } = findSubscriptions(rows, { today: "2026-09-30" });
  assert.deepEqual(subscriptions.map(brief), [
    {
      key: "zapp|41",
      cadence: "monthly",
      typical: 41.1,
      count: 3,
      firstDate: "2026-02-06",
      lastDate: "2026-09-27",
      stopped: false,
      confidence: "tagged",
      monthly: 41.1,
    },
    {
      key: "zapp|6",
      cadence: "monthly",
      typical: 6.2,
      count: 8,
      firstDate: "2026-01-22",
      lastDate: "2026-08-22",
      stopped: false,
      confidence: "schedule",
      monthly: 6.2,
    },
    {
      key: "zapp|unknown",
      cadence: "unknown",
      typical: 10.35,
      count: 2,
      firstDate: "2026-03-09",
      lastDate: "2026-09-26",
      stopped: false,
      confidence: "tagged",
      monthly: null,
    },
    {
      key: "zapp|1",
      cadence: "monthly",
      typical: 1.49,
      count: 6,
      firstDate: "2025-07-08",
      lastDate: "2025-12-08",
      stopped: true,
      confidence: "schedule",
      monthly: 1.49,
    },
  ]);
  assert.deepEqual(
    totals,
    { subscription: 47.3, bill: 0, other: 0 },
    "the unscheduled charges are not in the total",
  );
});

test("a tagged rental with two charges and an add-on lists both prices", () => {
  const rows = [
    tagged("2026-08-21", 88.2, "ZORPWEAR RENTAL"),
    tagged("2026-09-19", 88.2, "ZORPWEAR RENTAL"),
    tagged("2026-09-19", 17.35, "ZORPWEAR RENTAL"),
    ANCHOR,
  ];
  const { subscriptions } = findSubscriptions(rows, { today: "2026-09-30" });
  assert.deepEqual(subscriptions.map(brief), [
    {
      key: "zorpwear|88",
      cadence: "monthly",
      typical: 88.2,
      count: 2,
      firstDate: "2026-08-21",
      lastDate: "2026-09-19",
      stopped: false,
      confidence: "tagged",
      monthly: 88.2,
    },
    {
      key: "zorpwear|unknown",
      cadence: "unknown",
      typical: 17.35,
      count: 1,
      firstDate: "2026-09-19",
      lastDate: "2026-09-19",
      stopped: false,
      confidence: "tagged",
      monthly: null,
    },
  ]);
  assert.deepEqual(subscriptions[0]!.flags, [{ kind: "new", ref: "2026-08-21" }]);
});

test("a tagged plan charged on no clear schedule is listed with no cadence", () => {
  const rows = [
    tagged("2026-06-12", 4.99, "BLORPBOOKS AUDIO"),
    tagged("2026-08-02", 4.99, "BLORPBOOKS AUDIO"),
    tagged("2026-09-20", 4.99, "BLORPBOOKS AUDIO"),
    ANCHOR,
  ];
  const { subscriptions } = findSubscriptions(rows, { today: "2026-09-30" });
  assert.deepEqual(subscriptions.map(brief), [
    {
      key: "blorpbooks",
      cadence: "unknown",
      typical: 4.99,
      count: 3,
      firstDate: "2026-06-12",
      lastDate: "2026-09-20",
      stopped: false,
      confidence: "tagged",
      monthly: null,
    },
  ]);
});

test("two untagged charges are not a subscription, but two tagged ones are", () => {
  const plain = [...monthly("2026-08", 2, 20, "ZORP SHOP"), ANCHOR];
  assert.deepEqual(findSubscriptions(plain, { today: "2026-09-30" }).subscriptions, []);
  const mine = plain.map((t) => (t === ANCHOR ? t : { ...t, categoryId: TAG }));
  assert.deepEqual(
    findSubscriptions(mine, { today: "2026-09-30" }).subscriptions.map((s) => s.key),
    ["zorp shop"],
  );
});

test("every merchant with a tagged charge in the last 13 months appears, whatever its cadence", () => {
  const plans: Array<[string, string[]]> = [
    ["ZORPA WEEKLY", ["2026-09-02", "2026-09-09", "2026-09-16", "2026-09-23"]],
    ["ZORPB FORTNIGHT", ["2026-08-05", "2026-08-19", "2026-09-02", "2026-09-16"]],
    ["ZORPC MONTHLY", ["2026-07-03", "2026-08-03", "2026-09-03"]],
    ["ZORPD SIXWEEK", ["2026-06-01", "2026-07-13", "2026-08-24"]],
    ["ZORPE QUARTER", ["2025-12-10", "2026-03-10", "2026-06-10", "2026-09-10"]],
    ["ZORPF YEARLY", ["2025-10-15"]],
    ["ZORPG ONCE", ["2026-09-28"]],
    ["ZORPH LAPSED", ["2025-11-01", "2025-12-01", "2026-01-01"]],
    ["ZORPI ERRATIC", ["2026-01-04", "2026-01-06", "2026-04-30", "2026-05-02", "2026-09-01"]],
  ];
  const rows = plans.flatMap(([name, dates], i) => dates.map((d) => tagged(d, 3 + i, name)));
  const { subscriptions, hidden } = findSubscriptions([...rows, ANCHOR], {
    today: "2026-09-30",
    marks: [{ key: "zorpc monthly", kind: "not-subscription", ref: "", createdAt: 1 }],
  });
  const listed = new Set([...subscriptions, ...hidden].map((s) => s.key.split("|")[0]));
  assert.deepEqual([...listed].sort(), [
    "zorpa weekly",
    "zorpb fortnight",
    "zorpc monthly",
    "zorpd sixweek",
    "zorpe quarter",
    "zorpf yearly",
    "zorpg once",
    "zorph lapsed",
    "zorpi erratic",
  ]);
  assert.deepEqual(
    hidden.map((s) => s.key),
    ["zorpc monthly"],
  );
  const placed = [...subscriptions, ...hidden].flatMap((s) => s.ids);
  assert.deepEqual(
    [...placed].sort(),
    rows.map((t) => t.id).sort(),
    "every tagged charge is in exactly one row",
  );
});

test("a per-charge order code after '*' does not split one plan", () => {
  const codes = [
    "4QJ7X2M9P",
    "R8T3W6Z1K",
    "7HN2B5V8C",
    "L3P9D4F6Q",
    "2XM8K1R7T",
    "W6C4N9J3H",
    "9ZB5T2Q8L",
    "F1V7M3X6R",
  ];
  const months = ["2025-12", "2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06"];
  const rows = [
    ...[...months, "2026-07"].map((m, i) =>
      tagged(`${m}-25`, 4.2, `ZORBTIME*${codes[i]}${i % 2 ? " 800-555-0142 WA" : ""}`),
    ),
    tagged("2026-09-25", 5.6, "ZORBTIME*K5D2W8P4N"),
    ANCHOR,
  ];
  const { subscriptions } = findSubscriptions(rows, { today: "2026-09-30" });
  assert.deepEqual(subscriptions.map(brief), [
    {
      key: "zorbtime",
      cadence: "monthly",
      typical: 5.6,
      count: 9,
      firstDate: "2025-12-25",
      lastDate: "2026-09-25",
      stopped: false,
      confidence: "schedule",
      monthly: 5.6,
    },
  ]);
  assert.equal(subscriptions[0]!.merchant, "ZORBTIME");
  assert.deepEqual(subscriptions[0]!.flags, [{ kind: "price-up", ref: "560", from: 4.2 }]);
  assert.equal(
    subscriptionKey("Zorb Svcs*H2U81I83Q 800-555-0142 WA"),
    subscriptionKey("Zorb Svcs*P7K40M2XD"),
  );
  assert.equal(subscriptionKey("ZORP4KIDS*K2P9Q7R1A"), "zorp4kids");
});

test("tagged charges with no schedule yet are listed but not counted as a monthly cost", () => {
  const rows = [
    ...monthly("2026-01", 9, 15.49, "NETFLIX.COM 866-579-7172 CA"),
    tagged("2026-08-14", 18.4, "Zorpaudio zorpaudio.co/pay CA"),
    tagged("2026-09-02", 7.85, "Zorpaudio zorpaudio.co/pay CA"),
    tagged("2026-09-20", 0.95, "Zorpaudio zorpaudio.co/pay CA"),
    ANCHOR,
  ];
  const { subscriptions, totals } = findSubscriptions(rows, { today: "2026-09-30" });
  assert.deepEqual(subscriptions.map(brief), [
    {
      key: "netflix",
      cadence: "monthly",
      typical: 15.49,
      count: 9,
      firstDate: "2026-01-05",
      lastDate: "2026-09-05",
      stopped: false,
      confidence: "schedule",
      monthly: 15.49,
    },
    {
      key: "zorpaudio",
      cadence: "unknown",
      typical: 7.85,
      count: 3,
      firstDate: "2026-08-14",
      lastDate: "2026-09-20",
      stopped: false,
      confidence: "tagged",
      monthly: null,
    },
  ]);
  assert.equal(subscriptions[1]!.nextDate, null);
  assert.deepEqual(subscriptions[1]!.flags, [{ kind: "new", ref: "2026-08-14" }]);
  assert.deepEqual(totals, { subscription: 0, bill: 0, other: 15.49 });
});

test("a second tagged charge at that price on schedule gives it a cadence", () => {
  const rows = [
    tagged("2026-08-20", 0.95, "Zorpaudio zorpaudio.co/pay CA"),
    tagged("2026-09-02", 7.85, "Zorpaudio zorpaudio.co/pay CA"),
    tagged("2026-09-20", 0.95, "Zorpaudio zorpaudio.co/pay CA"),
    ANCHOR,
  ];
  const { subscriptions, totals } = findSubscriptions(rows, { today: "2026-09-30" });
  assert.deepEqual(
    subscriptions.map((s) => [s.key, s.cadence, s.count, s.monthly]),
    [
      ["zorpaudio|1", "monthly", 2, 0.95],
      ["zorpaudio|unknown", "unknown", 1, null],
    ],
  );
  assert.deepEqual(totals, { subscription: 0.95, bill: 0, other: 0 });
});

test("a domain cut short by the bank still names the merchant", () => {
  assert.equal(subscriptionKey("ZORPY WWW.ZORPY.COMPA"), "zorpy");
  const rows = [
    tagged("2026-08-21", 88.2, "ZORPY"),
    tagged("2026-09-19", 88.2, "ZORPY WWW.ZORPY.COMPA"),
    ANCHOR,
  ];
  const { subscriptions } = findSubscriptions(rows, { today: "2026-09-30" });
  assert.deepEqual(
    subscriptions.map((s) => [s.key, s.cadence, s.count]),
    [["zorpy", "monthly", 2]],
  );
});

test("no transaction is placed in two rows", () => {
  const rows = [
    ...monthly("2026-01", 9, 15.49, "NETFLIX.COM 866-579-7172 CA"),
    ...monthly("2026-01", 9, 0.99, "APPLE.COM/BILL 866-712-7753 CA", 3),
    ...monthly("2026-01", 9, 10.99, "APPLE.COM/BILL 866-712-7753 CA", 18),
    tagged("2026-09-29", 7.4, "APPLE.COM/BILL 866-712-7753 CA"),
    tagged("2026-09-22", 7.4, "APPLE.COM/BILL 866-712-7753 CA"),
    tagged("2026-05-11", 3.25, "BLORPIFY *Blorpify Drive b.co/paysupport#CA"),
    tagged("2026-06-11", 3.25, "B9QX771K b.co/paysupport#CA"),
    tagged("2026-07-11", 3.25, "Blorpify Drive"),
    tagged("2026-08-21", 88.2, "ZORPY"),
    tagged("2026-09-19", 88.2, "ZORPY WWW.ZORPY.COMPA"),
    tagged("2026-09-19", 17.35, "ZORPY"),
    ...everyDays("2026-06-06", 16, 7, (i) => 80 + (i % 5) * 23, "SAFEWAY #1234", "groceries"),
    ...churnedMortgage(),
    onLoan("2026-04-16", 1108.4, "ZORP ESCROW PAYOUT", "transfers"),
    onLoan("2026-06-20", 9000, "PRINCIPAL CURTAILMENT"),
    ANCHOR,
  ];
  const { subscriptions } = findSubscriptions(rows, { today: "2026-09-30" });
  const placed = subscriptions.flatMap((s) => s.ids);
  assert.equal(placed.length, 45);
  assert.equal(new Set(placed).size, 45);
});

test("after a price rise the monthly cost is the new price, not the median", () => {
  const was = [6.46, 6.47, 6.46, 6.47, 6.46, 6.47, 6.46, 6.47];
  const rows = [
    ...monthly("2026-01", 9, [...was, 8.63], "ZORPNOTES").map((t) => ({
      ...t,
      categoryId: TAG,
    })),
    ANCHOR,
  ];
  const { subscriptions, totals } = findSubscriptions(rows, { today: "2026-09-30" });
  assert.deepEqual(
    subscriptions.map((s) => [s.key, s.typical, s.monthly, s.last, s.flags]),
    [["zorpnotes", 8.63, 8.63, 8.63, [{ kind: "price-up", ref: "863", from: 6.47 }]]],
  );
  assert.deepEqual(totals, { subscription: 8.63, bill: 0, other: 0 });
});

test("each row is a subscription, a bill, or other, by the category of its latest categorized charge", () => {
  const filed = (rows: Transaction[], ...categories: (string | null)[]) =>
    rows.map((t, i) => ({ ...t, categoryId: categories[Math.min(i, categories.length - 1)]! }));
  const nine = (amount: number, description: string) => monthly("2026-01", 9, amount, description);
  const rows = [
    ...filed(nine(12.5, "ZORPFLIX"), TAG),
    ...filed(nine(2.99, "ZORPCLOUD"), TAG, TAG, TAG, TAG, TAG, TAG, TAG, TAG, null),
    ...filed(nine(45, "ZORPTEL"), TAG, TAG, TAG, TAG, TAG, TAG, "utilities"),
    ...filed(nine(310, "ZORPLOAN"), "debt"),
    ...filed(nine(96, "ZORPSURE"), "insurance"),
    ...filed(nine(820, "ZORPKIDS"), "childcare"),
    ...filed(nine(12, "ZORPBANK"), "fees"),
    ...nine(30, "ZORPGYM"),
    ...filed(nine(18, "ZORPMAG"), "entertainment"),
    ANCHOR,
  ];
  const { subscriptions, totals, total } = findSubscriptions(rows, { today: "2026-09-30" });
  assert.deepEqual(
    subscriptions.map((s) => [s.key, s.kind, s.monthly]),
    [
      ["zorpkids", "bill", 820],
      ["zorploan", "bill", 310],
      ["zorpsure", "bill", 96],
      ["zorptel", "bill", 45],
      ["zorpgym", "other", 30],
      ["zorpmag", "other", 18],
      ["zorpflix", "subscription", 12.5],
      ["zorpbank", "bill", 12],
      ["zorpcloud", "subscription", 2.99],
    ],
  );
  assert.deepEqual(totals, { subscription: 15.49, bill: 1283, other: 48 });
  assert.equal(total, 1346.49);
});

test("hidden rows keep their kind and stay out of the totals", () => {
  const rows = [
    ...monthly("2026-01", 9, 310, "ZORPLOAN").map((t) => ({ ...t, categoryId: "debt" })),
    ...monthly("2026-01", 9, 12.5, "ZORPFLIX").map((t) => ({ ...t, categoryId: TAG })),
    ANCHOR,
  ];
  const marks: SubscriptionMark[] = [
    { key: "zorploan", kind: "not-subscription", ref: "", createdAt: 1 },
  ];
  const { subscriptions, hidden, totals } = findSubscriptions(rows, {
    today: "2026-09-30",
    marks,
  });
  assert.deepEqual(
    [...subscriptions, ...hidden].map((s) => [s.key, s.kind]),
    [
      ["zorpflix", "subscription"],
      ["zorploan", "bill"],
    ],
  );
  assert.deepEqual(totals, { subscription: 12.5, bill: 0, other: 0 });
});

function onLoan(
  date: string,
  amount: number,
  description: string,
  categoryId: string | null = "housing",
  accountName = "Zorp Home Loan",
): Transaction {
  return { ...tx(date, -amount, description, categoryId), accountName, accountKind: "mortgage" };
}

/** Nine invented mortgage payments whose bank line changes three times. */
function churnedMortgage(): Transaction[] {
  const dates = [
    "2025-12-12",
    "2026-01-12",
    "2026-02-12",
    "2026-03-12",
    "2026-04-12",
    "2026-05-11",
    "2026-06-08",
    "2026-07-09",
    "2026-08-07",
  ];
  const lines = ["ZORPBANK ONLINE PMT 9917", "BY POST", "ZORPLEND", "ZORPLEND"];
  return dates.map((d, i) => onLoan(d, 1843.27, lines[Math.max(0, i - 5)]!));
}

function loanRow(s: Subscription) {
  return {
    key: s.key,
    merchant: s.merchant,
    kind: s.kind,
    confidence: s.confidence,
    cadence: s.cadence,
    monthly: s.monthly,
    count: s.count,
    lastDate: s.lastDate,
    stopped: s.stopped,
    flags: s.flags,
  };
}

test("a mortgage whose bank line keeps changing is one bill keyed on its account", () => {
  const rows = [...churnedMortgage(), tx("2026-08-28", -4, "ZORPCAFE", "coffee")];
  const { subscriptions, totals, total } = findSubscriptions(rows, { today: "2026-09-30" });
  assert.deepEqual(subscriptions.map(loanRow), [
    {
      key: "account:mortgage:zorp home loan",
      merchant: "Zorp Home Loan",
      kind: "bill",
      confidence: "account",
      cadence: "monthly",
      monthly: 1843.27,
      count: 9,
      lastDate: "2026-08-07",
      stopped: false,
      flags: [],
    },
  ]);
  assert.deepEqual(totals, { subscription: 0, bill: 1843.27, other: 0 });
  assert.equal(total, 1843.27);
});

test("a mortgage feed that ends months before the ledger is stale, not stopped, and still counted", () => {
  const rows = [...churnedMortgage(), tx("2026-10-02", -4, "ZORPCAFE", "coffee")];
  const { subscriptions, totals, asOf } = findSubscriptions(rows, { today: "2026-10-05" });
  assert.equal(asOf, "2026-10-02");
  assert.deepEqual(subscriptions.map(loanRow), [
    {
      key: "account:mortgage:zorp home loan",
      merchant: "Zorp Home Loan",
      kind: "bill",
      confidence: "account",
      cadence: "monthly",
      monthly: 1843.27,
      count: 9,
      lastDate: "2026-08-07",
      stopped: false,
      flags: [{ kind: "stale-account", ref: "2026-08-07" }],
    },
  ]);
  assert.deepEqual(totals, { subscription: 0, bill: 1843.27, other: 0 });
});

test("an escrow payout filed under transfers is not a mortgage payment", () => {
  const escrow = onLoan("2026-04-16", 1108.4, "ZORP ESCROW PAYOUT", "transfers");
  const payments = churnedMortgage();
  const rows = [...payments, escrow, tx("2026-08-28", -4, "ZORPCAFE", "coffee")];
  const { subscriptions } = findSubscriptions(rows, { today: "2026-09-30" });
  assert.deepEqual(
    subscriptions.map((s) => [s.key, s.ids]),
    [["account:mortgage:zorp home loan", payments.map((t) => t.id)]],
  );
});

test("hardware-store receipts filed under housing are not a bill, while the mortgage is", () => {
  const receipts = [
    ["2026-01-09", 84.12],
    ["2026-02-07", 212.4],
    ["2026-03-14", 37.95],
    ["2026-04-11", 129.0],
    ["2026-05-08", 61.33],
    ["2026-06-13", 18.47],
    ["2026-07-10", 305.6],
    ["2026-08-08", 92.15],
    ["2026-09-12", 44.8],
  ] as const;
  const rows = [
    ...receipts.map(([d, a]) => tx(d, -a, "ZORPHAUS HARDWARE #0412", "housing")),
    ...churnedMortgage(),
  ];
  const { subscriptions } = findSubscriptions(rows, { today: "2026-09-30" });
  assert.deepEqual(
    subscriptions.map((s) => s.key),
    ["account:mortgage:zorp home loan"],
  );
});

test("every loan account with a payment in the last 13 months appears once per payment band", () => {
  const home = churnedMortgage();
  const payoff = onLoan("2026-06-20", 9000, "PRINCIPAL CURTAILMENT");
  const cabin = [
    onLoan("2026-08-15", 612.5, "ZORPLEND PMT", "housing", "Zorp Cabin Loan"),
    onLoan("2026-09-15", 612.5, "ZORPLEND", "housing", "Zorp Cabin Loan"),
  ];
  const boat = [onLoan("2026-09-01", 240, "ZORPMARINE", null, "Zorp Boat Loan")];
  const paidOff = [
    onLoan("2025-05-02", 410, "ZORPAUTO", "housing", "Zorp Old Loan"),
    onLoan("2025-06-02", 410, "ZORPAUTO", "housing", "Zorp Old Loan"),
  ];
  const rows = [...home, payoff, ...cabin, ...boat, ...paidOff, ANCHOR];
  const { subscriptions, totals } = findSubscriptions(rows, { today: "2026-09-30" });
  assert.deepEqual(
    subscriptions.map((s) => [s.key, s.kind, s.cadence, s.monthly, s.count]),
    [
      ["account:mortgage:zorp home loan|1843", "bill", "monthly", 1843.27, 9],
      ["account:mortgage:zorp cabin loan", "bill", "monthly", 612.5, 2],
      ["account:mortgage:zorp boat loan", "bill", "unknown", null, 1],
      ["account:mortgage:zorp home loan|9000", "bill", "unknown", null, 1],
    ],
  );
  assert.deepEqual(totals, { subscription: 0, bill: 2455.77, other: 0 });
  const placed = subscriptions.flatMap((s) => s.ids);
  assert.deepEqual(
    [...placed].sort(),
    [...home, payoff, ...cabin, ...boat].map((t) => t.id).sort(),
    "every recent loan payment is in exactly one row",
  );
});

test("a utility bill with one missed month is still monthly; the same pattern uncategorized is not", () => {
  const dates = ["2026-06-15", "2026-08-14", "2026-09-15"];
  const rows = [
    ...dates.map((d) => tx(d, -71.2, "ZORPWATER UTIL", "utilities")),
    ...dates.map((d) => tx(d, -71.2, "ZORPSALON")),
    ANCHOR,
  ];
  const { subscriptions } = findSubscriptions(rows, { today: "2026-09-30" });
  assert.deepEqual(
    subscriptions.map((s) => [s.key, s.kind, s.cadence, s.monthly]),
    [["zorpwater", "bill", "monthly", 71.2]],
  );
});

/** A mortgage statement export covering `dates`, one invented payment each. */
function mortgageExport(path: string, dates: string[]) {
  const lines = dates.map((d) => `${d},ZORPLEND PMT,-1843.27`);
  return parseStatementAtPath(path, ["Date,Description,Amount", ...lines].join("\n"));
}

test("a mortgage imported from two statement files named for different periods is one current bill", () => {
  const through = (month: string) =>
    `Mortgage/Zorp_Lending_Transactions_2025-12_through_2026-${month}.csv`;
  const august = churnedMortgage().map((t) => t.date);
  const november = [...august, "2026-09-08", "2026-10-08", "2026-11-09"];
  const checking = parseStatementAtPath(
    "Checking/Zorp_Checking.csv",
    "Date,Description,Amount\n2026-11-18,ZORPCAFE,-4.00\n",
  );
  const rules = defaultRules();
  const first = mergeImport([], [mortgageExport(through("08"), august)], rules, 1);
  const { transactions, summary } = mergeImport(
    first.transactions,
    [mortgageExport(through("11"), november), checking],
    rules,
    2,
  );
  assert.deepEqual(summary, { added: 4, skipped: 9, uncategorized: 4, files: 2 });
  const { subscriptions } = findSubscriptions(transactions, { today: "2026-11-20" });
  assert.deepEqual(subscriptions.map(loanRow), [
    {
      key: "account:mortgage:mortgage/zorp lending transactions",
      merchant: "Mortgage/Zorp Lending Transactions",
      kind: "bill",
      confidence: "account",
      cadence: "monthly",
      monthly: 1843.27,
      count: 12,
      lastDate: "2026-11-09",
      stopped: false,
      flags: [],
    },
  ]);
});
