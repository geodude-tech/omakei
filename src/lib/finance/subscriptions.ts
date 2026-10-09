/**
 * Recurring charges — subscriptions and bills — found in the ledger itself.
 *
 * Pure: no clock, no I/O. The caller says what "today" is, and the result is
 * the same for the same transactions every time. The editor's card and
 * `scripts/omakei-subscriptions.mjs` both call this, so they never disagree.
 * The rules and thresholds are `docs/spec/subscriptions.md`.
 */
import { extractMerchant, isGenericMerchant, spacedForm } from "./fingerprint.ts";
import { isTransferTx } from "./transfers.ts";
import type { Transaction } from "./types.ts";

export type Cadence = "weekly" | "monthly" | "yearly";

export type FlagKind = "price-up" | "new" | "stopped";

export type MarkKind = "not-subscription" | FlagKind;

export const MARK_KINDS: readonly MarkKind[] = ["not-subscription", "price-up", "new", "stopped"];

/** Limits on stored marks; `ledger-db.mjs` enforces the same ones on write. */
export const MAX_MARK_KEY = 200;
export const MAX_MARK_REF = 40;
export const MAX_MARKS = 5000;

/** What the user said about one subscription, stored in the ledger. */
export interface SubscriptionMark {
  key: string;
  kind: MarkKind;
  /** "" for not-subscription; otherwise the dismissed flag's `ref`. */
  ref: string;
  createdAt: number;
}

export interface SubscriptionFlag {
  kind: FlagKind;
  /** Identifies this occurrence, so dismissing it does not hide the next one. */
  ref: string;
  /** For price-up: what it used to cost. */
  from?: number;
}

export interface Subscription {
  key: string;
  merchant: string;
  cadence: Cadence;
  /** Median of the last three charges, as a positive number. */
  typical: number;
  /** The amount moves from charge to charge, like a utility bill. */
  variable: boolean;
  /** The most recent charge, as a positive number. */
  last: number;
  firstDate: string;
  lastDate: string;
  nextDate: string;
  /** What it costs in an average month. */
  monthly: number;
  count: number;
  stopped: boolean;
  flags: SubscriptionFlag[];
}

export interface SubscriptionOptions {
  /** "YYYY-MM-DD". The comparison date is the latest transaction, capped here. */
  today?: string;
  marks?: readonly SubscriptionMark[];
}

export interface SubscriptionResult {
  /** Active first, biggest monthly cost first; then the ones that stopped. */
  subscriptions: Subscription[];
  /** Marked "not a subscription" by the user. */
  hidden: Subscription[];
  /** The date "new" and "stopped" were judged against. */
  asOf: string;
}

/** Everyday buying, not bills: a weekly grocery run is not a subscription. */
const NOT_BILLS = new Set(["groceries", "dining", "coffee"]);

/**
 * Where an amount that moves every month is still one bill. A salon visited
 * about monthly is regular too, but it is not a bill; an electric bill is.
 */
const VARIABLE_BILLS = new Set(["utilities", "insurance", "housing", "debt", "childcare"]);

const CADENCES: Array<{
  cadence: Cadence;
  min: number;
  max: number;
  days: number;
  minCount: number;
}> = [
  { cadence: "weekly", min: 5, max: 9, days: 7, minCount: 4 },
  { cadence: "monthly", min: 26, max: 35, days: 30.44, minCount: 3 },
  { cadence: "yearly", min: 350, max: 380, days: 365.25, minCount: 2 },
];

const REGULAR_SHARE = 0.75;
const AMOUNT_TOLERANCE = 0.15;
const AMOUNT_FLOOR = 2;
const VARIABLE_MIN_COUNT = 4;
const BAND_STEP = 0.25;
const BAND_SPREAD = 0.03;
const BAND_SPREAD_FLOOR = 0.5;
const PRICE_UP_PCT = 0.05;
const PRICE_UP_FLOOR = 0.5;
const STEADY_PCT = 0.005;
const STEADY_FLOOR = 0.1;
const PRICE_UP_WINDOW = 3;
const NEW_DAYS = 90;

/* ------------------------------------------------------------ merchant key */

const DATES = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g;
const CARD_MASKS = /(?:\bx{2,}|\*+|#)\s*\d{4}\b|\bcard\s*(?:ending\s*(?:in\s*)?)?\d{4}\b/gi;
const HASH_CODES = /#\s*\w+/g;
const WEB_EDGES = /^www | (?:com|net|org|io)$/g;

/**
 * One key per merchant, whatever the bank put around its name: a date, a
 * masked card number, a store number, a phone number, a city.
 */
export function subscriptionKey(description: string): string {
  const cleaned = description
    .replace(DATES, " ")
    .replace(CARD_MASKS, " ")
    .replace(HASH_CODES, " ")
    .replace(/\s+/g, " ")
    .trim();
  return spacedForm(extractMerchant(cleaned)).replace(WEB_EDGES, "").trim();
}

/* ------------------------------------------------------------------ dates */

function dayNumber(iso: string): number {
  return Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000);
}

function isoFromParts(y: number, m: number, d: number): string {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const day = Math.min(d, last);
  return `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** The next charge: a week later, or the same day next month / year, clamped to month end. */
export function nextDateAfter(iso: string, cadence: Cadence): string {
  const y = +iso.slice(0, 4);
  const m = +iso.slice(5, 7);
  const d = +iso.slice(8, 10);
  if (cadence === "weekly") {
    const next = new Date(Date.UTC(y, m - 1, d + 7));
    return isoFromParts(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate());
  }
  if (cadence === "yearly") return isoFromParts(y + 1, m, d);
  return m === 12 ? isoFromParts(y + 1, 1, d) : isoFromParts(y, m + 1, d);
}

/* ------------------------------------------------------------------ maths */

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function closeEnough(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.max(AMOUNT_TOLERANCE * Math.max(a, b), AMOUNT_FLOOR);
}

/* -------------------------------------------------------------- detection */

type Charge = { date: string; amount: number; description: string; categoryId: string | null };

function isCandidate(tx: Transaction): boolean {
  if (!tx || typeof tx.date !== "string" || typeof tx.description !== "string") return false;
  if (!(typeof tx.amount === "number" && tx.amount < 0)) return false;
  if (isTransferTx(tx)) return false;
  if (tx.categoryId && NOT_BILLS.has(tx.categoryId)) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(tx.date)) return false;
  return true;
}

/**
 * A price rise is a step from one price that held to a higher one: the charges
 * before the step agree with each other (at least two of them, within 0.5% or
 * $0.10), and the step is at least 5% and $0.50. A water bill that wanders by a
 * few dollars has no "old price", so it is never flagged. Once the new price
 * has been charged more than three times it is just the price.
 */
function priceRise(amounts: number[]): SubscriptionFlag | null {
  const same = (a: number, b: number) => Math.abs(a - b) <= Math.max(STEADY_PCT * b, STEADY_FLOOR);
  const now = amounts[amounts.length - 1]!;
  let step = amounts.length - 1;
  while (step > 0 && same(amounts[step - 1]!, now)) step--;
  if (step === 0 || amounts.length - step > PRICE_UP_WINDOW) return null;
  const was = amounts[step - 1]!;
  let from = step - 1;
  while (from > 0 && step - from < 6 && same(amounts[from - 1]!, was)) from--;
  const prior = amounts.slice(from, step);
  if (prior.length < 2) return null;
  const before = median(prior);
  const rise = now - before;
  if (rise < before * PRICE_UP_PCT || rise < PRICE_UP_FLOOR) return null;
  return { kind: "price-up", ref: String(Math.round(now * 100)), from: round2(before) };
}

/** A recurring series, or null when these charges do not repeat on a schedule. */
function seriesOf(key: string, charges: Charge[], asOfDay: number): Subscription | null {
  const sorted = [...charges].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (sorted.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++)
    gaps.push(dayNumber(sorted[i]!.date) - dayNumber(sorted[i - 1]!.date));
  const gap = median(gaps);
  const band = CADENCES.find((c) => gap >= c.min && gap <= c.max);
  if (!band || sorted.length < band.minCount) return null;
  const regular = gaps.filter((g) => g >= band.min && g <= band.max).length;
  if (regular / gaps.length < REGULAR_SHARE) return null;

  const amounts = sorted.map((c) => c.amount);
  const lastCharge = sorted[sorted.length - 1]!;
  let steady = 0;
  for (let i = 1; i < amounts.length; i++) if (closeEnough(amounts[i]!, amounts[i - 1]!)) steady++;
  const variable = steady / (amounts.length - 1) < REGULAR_SHARE;
  if (variable) {
    if (band.cadence !== "monthly" || sorted.length < VARIABLE_MIN_COUNT) return null;
    if (!VARIABLE_BILLS.has(lastCharge.categoryId ?? "")) return null;
  }

  const lastDay = dayNumber(lastCharge.date);
  const idle = asOfDay - lastDay;
  // Long gone: history, not something to act on.
  if (idle > band.days * 3) return null;

  const typical = round2(median(amounts.slice(-3)));
  const flags: SubscriptionFlag[] = [];
  if (!variable) {
    const flag = priceRise(amounts);
    if (flag) flags.push(flag);
  }
  const firstDate = sorted[0]!.date;
  if (asOfDay - dayNumber(firstDate) <= NEW_DAYS) flags.push({ kind: "new", ref: firstDate });
  const stopped = idle > band.days * 1.5 + 3;
  if (stopped) flags.push({ kind: "stopped", ref: lastCharge.date });

  const monthly =
    band.cadence === "weekly"
      ? (typical * 52) / 12
      : band.cadence === "yearly"
        ? typical / 12
        : typical;
  return {
    key,
    merchant: extractMerchant(lastCharge.description) || key,
    cadence: band.cadence,
    typical,
    variable,
    last: round2(lastCharge.amount),
    firstDate,
    lastDate: lastCharge.date,
    nextDate: nextDateAfter(lastCharge.date, band.cadence),
    monthly: round2(monthly),
    count: sorted.length,
    stopped,
    flags,
  };
}

/**
 * Charges at one merchant that are not one series may be several: two plans
 * from one app store. Split by amount and try each band on its own.
 */
function bandsOf(charges: Charge[]): Charge[][] {
  const byAmount = [...charges].sort((a, b) => a.amount - b.amount);
  const bands: Charge[][] = [];
  let floor = -Infinity;
  for (const c of byAmount) {
    if (c.amount > floor * (1 + BAND_STEP) + 0.01 || bands.length === 0) {
      bands.push([]);
      floor = c.amount;
    }
    bands[bands.length - 1]!.push(c);
  }
  return bands;
}

export function findSubscriptions(
  transactions: readonly Transaction[],
  options: SubscriptionOptions = {},
): SubscriptionResult {
  let latest = "";
  const groups = new Map<string, Charge[]>();
  // Bank lines repeat; name each distinct one once. "" means not a merchant.
  const keyOf = new Map<string, string>();
  for (const tx of transactions) {
    if (tx && typeof tx.date === "string" && tx.date > latest) latest = tx.date;
    if (!isCandidate(tx)) continue;
    let key = keyOf.get(tx.description);
    if (key === undefined) {
      const generic =
        /\batm\b/i.test(tx.description) || isGenericMerchant(extractMerchant(tx.description));
      key = generic ? "" : subscriptionKey(tx.description);
      keyOf.set(tx.description, key);
    }
    if (!key) continue;
    const list = groups.get(key) ?? [];
    list.push({
      date: tx.date,
      amount: Math.abs(tx.amount),
      description: tx.description,
      categoryId: tx.categoryId ?? null,
    });
    groups.set(key, list);
  }

  const asOf = options.today && options.today < latest ? options.today : latest;
  if (!asOf) return { subscriptions: [], hidden: [], asOf: "" };
  const asOfDay = dayNumber(asOf);

  const found: Subscription[] = [];
  for (const [key, charges] of groups) {
    const whole = seriesOf(key, charges, asOfDay);
    if (whole) {
      found.push(whole);
      continue;
    }
    const bands = bandsOf(charges);
    if (bands.length < 2) continue;
    for (const band of bands) {
      // A band has to be one price, not a range a busy store's receipts
      // happen to fall into on a schedule.
      const mid = median(band.map((c) => c.amount));
      if (
        band.some((c) => Math.abs(c.amount - mid) > Math.max(BAND_SPREAD * mid, BAND_SPREAD_FLOOR))
      )
        continue;
      const sub = seriesOf(key, band, asOfDay);
      if (sub) found.push({ ...sub, key: `${key}|${Math.round(sub.typical)}` });
    }
  }

  const marks = options.marks ?? [];
  const notSubs = new Set(marks.filter((m) => m.kind === "not-subscription").map((m) => m.key));
  const dismissed = new Set(marks.map((m) => `${m.key}\u0000${m.kind}\u0000${m.ref}`));
  const subscriptions: Subscription[] = [];
  const hidden: Subscription[] = [];
  for (const sub of found) {
    const visible = {
      ...sub,
      flags: sub.flags.filter((f) => !dismissed.has(`${sub.key}\u0000${f.kind}\u0000${f.ref}`)),
    };
    (notSubs.has(sub.key) ? hidden : subscriptions).push(visible);
  }
  const order = (a: Subscription, b: Subscription) =>
    Number(a.stopped) - Number(b.stopped) || b.monthly - a.monthly || a.key.localeCompare(b.key);
  return { subscriptions: subscriptions.sort(order), hidden: hidden.sort(order), asOf };
}

/** Total monthly cost of what is still running. */
export function monthlyTotal(subscriptions: readonly Subscription[]): number {
  return round2(subscriptions.filter((s) => !s.stopped).reduce((sum, s) => sum + s.monthly, 0));
}

/** Marks as read from the ledger, which may hold anything. Bad entries are dropped. */
export function parseSubscriptionMarks(raw: unknown): SubscriptionMark[] {
  if (!Array.isArray(raw)) return [];
  const out: SubscriptionMark[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const m = item as Partial<SubscriptionMark>;
    if (typeof m.key !== "string" || !m.key || m.key.length > MAX_MARK_KEY) continue;
    if (!MARK_KINDS.includes(m.kind as MarkKind)) continue;
    const ref = typeof m.ref === "string" ? m.ref : "";
    if (ref.length > MAX_MARK_REF) continue;
    out.push({
      key: m.key,
      kind: m.kind as MarkKind,
      ref,
      createdAt: typeof m.createdAt === "number" && Number.isFinite(m.createdAt) ? m.createdAt : 0,
    });
  }
  return out.slice(0, MAX_MARKS);
}
