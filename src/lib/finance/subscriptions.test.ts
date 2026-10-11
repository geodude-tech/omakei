import assert from "node:assert/strict";
import { test } from "node:test";
import {
  findSubscriptions,
  monthlyTotal,
  nextDateAfter,
  parseSubscriptionMarks,
  subscriptionKey,
  type Subscription,
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
  const { subscriptions } = findSubscriptions(rows, { today: "2026-09-30" });
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
  assert.equal(monthlyTotal(subscriptions), 3.25);
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
  const { subscriptions } = findSubscriptions(rows, { today: "2026-09-30" });
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
  assert.equal(monthlyTotal(subscriptions), 47.3, "the unscheduled charges are not in the total");
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
      typical: 4.2,
      count: 9,
      firstDate: "2025-12-25",
      lastDate: "2026-09-25",
      stopped: false,
      confidence: "schedule",
      monthly: 4.2,
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
  const { subscriptions } = findSubscriptions(rows, { today: "2026-09-30" });
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
  assert.equal(monthlyTotal(subscriptions), 15.49);
});

test("a second tagged charge at that price on schedule gives it a cadence", () => {
  const rows = [
    tagged("2026-08-20", 0.95, "Zorpaudio zorpaudio.co/pay CA"),
    tagged("2026-09-02", 7.85, "Zorpaudio zorpaudio.co/pay CA"),
    tagged("2026-09-20", 0.95, "Zorpaudio zorpaudio.co/pay CA"),
    ANCHOR,
  ];
  const { subscriptions } = findSubscriptions(rows, { today: "2026-09-30" });
  assert.deepEqual(
    subscriptions.map((s) => [s.key, s.cadence, s.count, s.monthly]),
    [
      ["zorpaudio|1", "monthly", 2, 0.95],
      ["zorpaudio|unknown", "unknown", 1, null],
    ],
  );
  assert.equal(monthlyTotal(subscriptions), 0.95);
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
    ANCHOR,
  ];
  const { subscriptions } = findSubscriptions(rows, { today: "2026-09-30" });
  const placed = subscriptions.flatMap((s) => s.ids);
  assert.equal(placed.length, 35);
  assert.equal(new Set(placed).size, 35);
});
