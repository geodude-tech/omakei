/**
 * Recurring charges — subscriptions and bills — found in the ledger itself.
 *
 * Pure: no clock, no I/O. The caller says what "today" is, and the result is
 * the same for the same transactions every time. The editor's card and
 * `scripts/omakei-subscriptions.mjs` both call this, so they never disagree.
 * The rules and thresholds are `docs/spec/subscriptions.md`.
 */
import { extractMerchant, isGenericMerchant, REFERENCE_CODES, spacedForm } from "./fingerprint.ts";
import { isTransferTx } from "./transfers.ts";
import type { Transaction } from "./types.ts";

export type Cadence = "weekly" | "monthly" | "yearly";

/**
 * Why a series is listed. "schedule": its charges repeat on a schedule.
 * "tagged": the user filed its charges under Subscriptions, and there are too
 * few of them, or they are too irregular, for the schedule rules.
 */
export type Confidence = "schedule" | "tagged";

/**
 * What a recurring charge is to the user, read off the category they filed it
 * under: a plan they chose, a bill they owe, or neither said.
 */
export type SubscriptionKind = "subscription" | "bill" | "other";

/** The order the kinds are shown in. */
export const SUBSCRIPTION_KINDS: readonly SubscriptionKind[] = ["subscription", "bill", "other"];

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

interface SubscriptionBase {
  key: string;
  merchant: string;
  kind: SubscriptionKind;
  confidence: Confidence;
  /**
   * What the next charge should be, as a positive number: the new price after
   * a price rise, otherwise the median of the last three charges.
   */
  typical: number;
  /** The amount moves from charge to charge, like a utility bill. */
  variable: boolean;
  /** The most recent charge, as a positive number. */
  last: number;
  firstDate: string;
  lastDate: string;
  count: number;
  stopped: boolean;
  flags: SubscriptionFlag[];
  /** The transactions in this row. No transaction is in two rows. */
  ids: string[];
}

/**
 * A row with a cadence has a next date and a monthly cost. A row with cadence
 * "unknown" holds tagged charges with no second charge at their price on
 * schedule yet: it is listed, but it has neither, and it is never stopped.
 */
export type Subscription = SubscriptionBase &
  (
    | { cadence: Cadence; nextDate: string; monthly: number }
    | { cadence: "unknown"; nextDate: null; monthly: null }
  );

export interface SubscriptionOptions {
  /** "YYYY-MM-DD". The comparison date is the latest transaction, capped here. */
  today?: string;
  marks?: readonly SubscriptionMark[];
}

export interface SubscriptionResult {
  /** Active first, biggest monthly cost first; then the unknown cadence; then the ones that stopped. */
  subscriptions: Subscription[];
  /** Marked "not a subscription" by the user. */
  hidden: Subscription[];
  /** Monthly cost of each kind's listed rows that have a cadence and have not stopped. */
  totals: Record<SubscriptionKind, number>;
  /** The date "new" and "stopped" were judged against. */
  asOf: string;
}

/** Everyday buying, not bills: a weekly grocery run is not a subscription. */
const NOT_BILLS = new Set(["groceries", "dining", "coffee"]);

/** The user's own word that a charge is a subscription. */
const TAGGED = "subscriptions";

/** Categories that say what a charge is. Any other category, or none, is "other". */
const KIND_OF_CATEGORY = new Map<string, SubscriptionKind>([
  [TAGGED, "subscription"],
  ["housing", "bill"],
  ["utilities", "bill"],
  ["insurance", "bill"],
  ["debt", "bill"],
  ["childcare", "bill"],
  ["fees", "bill"],
]);

type Band = { cadence: Cadence; min: number; max: number; days: number; minCount: number };

const MONTHLY: Band = { cadence: "monthly", min: 26, max: 35, days: 30.44, minCount: 3 };

const CADENCES: Band[] = [
  { cadence: "weekly", min: 5, max: 9, days: 7, minCount: 4 },
  MONTHLY,
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
const TAGGED_HISTORY_DAYS = 396;

/* ------------------------------------------------------------ merchant key */

const DATES = /\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g;
const CARD_MASKS = /(?:\bx{2,}|\*+|#)\s*\d{4}\b|\bcard\s*(?:ending\s*(?:in\s*)?)?\d{4}\b/gi;
const HASH_CODES = /#\s*\w+/g;
const WEB_EDGES = /^www | (?:com|net|org|io)$/g;
const LABEL = "([a-z0-9-]*[a-z][a-z0-9-]*)";
const DOMAIN = new RegExp(
  `(?:^|[^a-z0-9-])(?:www\\.${LABEL}\\.|${LABEL}\\.(?:com|co|net|org|io|tv|app)(?![a-z0-9]))`,
  "i",
);
const SHORT_LINK_MAX = 2;

type LineKey = { key: string; shortLink: string | null };

/**
 * A web domain is the merchant's most stable name, so it wins over a processor
 * prefix or billing code in front of it. `www.` marks a domain even when the
 * bank cut its ending short. A one- or two-letter domain is a short link that
 * names no merchant: the brand in front of it is the key, and a line with no
 * brand keeps the link's name in `shortLink` for `findSubscriptions` to place.
 */
function lineKey(description: string): LineKey {
  const domain = DOMAIN.exec(description);
  const label = (domain?.[1] ?? domain?.[2])?.toLowerCase();
  if (label && label.length > SHORT_LINK_MAX) return { key: label, shortLink: null };
  const cleaned = (domain ? description.slice(0, domain.index) : description)
    .replace(DATES, " ")
    .replace(CARD_MASKS, " ")
    .replace(HASH_CODES, " ")
    .replace(REFERENCE_CODES, " ")
    .replace(/\s+/g, " ")
    .trim();
  const brand = spacedForm(extractMerchant(cleaned)).replace(WEB_EDGES, "").trim();
  return label ? { key: brand || label, shortLink: label } : { key: brand, shortLink: null };
}

/**
 * One key per merchant, whatever the bank put around its name: a date, a
 * masked card number, a store number, a phone number, a city, a per-charge
 * reference code.
 */
export function subscriptionKey(description: string): string {
  return lineKey(description).key;
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

type Charge = {
  id: string;
  date: string;
  amount: number;
  description: string;
  categoryId: string | null;
};

/** In the band, or twice it: one missed charge does not break a schedule. */
function fits(gap: number, band: Band): boolean {
  return (gap >= band.min && gap <= band.max) || (gap >= 2 * band.min && gap <= 2 * band.max);
}

function scheduleOf(gaps: number[], count: number): Band | null {
  const gap = median(gaps);
  const band = CADENCES.find((c) => gap >= c.min && gap <= c.max);
  if (!band || count < band.minCount) return null;
  const regular = gaps.filter((g) => fits(g, band)).length;
  return regular / gaps.length < REGULAR_SHARE ? null : band;
}

/** A tagged series has a cadence once its latest charge came one period after the one before. */
function taggedPace(gaps: number[]): Band | null {
  const latest = gaps[gaps.length - 1];
  if (latest === undefined) return null;
  return CADENCES.find((c) => latest >= c.min && latest <= c.max) ?? null;
}

/**
 * The name most of its charges carry, so one odd billing line does not rename
 * it. Names that hold the key come first: a code-only line is not a name.
 */
function nameOf(sorted: Charge[], key: string): string {
  const names = sorted.map((c) => extractMerchant(c.description)).reverse();
  const branded = names.filter((n) =>
    spacedForm(n).replace(/ /g, "").includes(key.replace(/ /g, "")),
  );
  const counts = new Map<string, number>();
  for (const name of branded.length ? branded : names) {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let best = key;
  let most = 0;
  for (const [name, n] of counts) {
    if (name && n > most) {
      best = name;
      most = n;
    }
  }
  return best;
}

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

/** The kind the user's latest word on these charges gives: the newest charge with a category. */
function kindOf(sorted: Charge[]): SubscriptionKind {
  for (let i = sorted.length - 1; i >= 0; i--) {
    const category = sorted[i]!.categoryId;
    if (category) return KIND_OF_CATEGORY.get(category) ?? "other";
  }
  return "other";
}

/**
 * How a series is judged. "schedule": the charges must repeat on one.
 * "tagged": the user has already said they are a subscription, and the latest
 * gap gives the cadence, or "unknown". "unscheduled": tagged charges at
 * different prices that together have no cadence.
 */
type Pace = "schedule" | "tagged" | "unscheduled";

/** A recurring series, or null. */
function seriesOf(
  key: string,
  charges: Charge[],
  asOfDay: number,
  pace: Pace,
): Subscription | null {
  const sorted = [...charges].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  if (sorted.length === 0) return null;
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++)
    gaps.push(dayNumber(sorted[i]!.date) - dayNumber(sorted[i - 1]!.date));
  const band =
    pace === "schedule"
      ? scheduleOf(gaps, sorted.length)
      : pace === "tagged"
        ? taggedPace(gaps)
        : null;
  if (!band && pace === "schedule") return null;
  const confidence: Confidence = pace === "schedule" ? "schedule" : "tagged";

  const amounts = sorted.map((c) => c.amount);
  const lastCharge = sorted[sorted.length - 1]!;
  let steady = 0;
  for (let i = 1; i < amounts.length; i++) if (closeEnough(amounts[i]!, amounts[i - 1]!)) steady++;
  const variable = steady / (amounts.length - 1) < REGULAR_SHARE;
  const kind = kindOf(sorted);
  if (variable && band && confidence === "schedule") {
    if (band.cadence !== "monthly" || sorted.length < VARIABLE_MIN_COUNT) return null;
    if (kind !== "bill") return null;
  }

  const lastDay = dayNumber(lastCharge.date);
  const idle = asOfDay - lastDay;
  const periods = band ? band.days * 3 : 0;
  const tagged = sorted.some((c) => c.categoryId === TAGGED);
  const history = tagged ? Math.max(periods, TAGGED_HISTORY_DAYS) : periods;
  if (idle > history) return null;

  const rise = variable ? null : priceRise(amounts);
  const typical = round2(rise ? lastCharge.amount : median(amounts.slice(-3)));
  const flags: SubscriptionFlag[] = rise ? [rise] : [];
  const firstDate = sorted[0]!.date;
  if (asOfDay - dayNumber(firstDate) <= NEW_DAYS) flags.push({ kind: "new", ref: firstDate });
  const stopped = band !== null && idle > band.days * 1.5 + 3;
  if (stopped) flags.push({ kind: "stopped", ref: lastCharge.date });

  const base = {
    key,
    merchant: nameOf(sorted, key),
    kind,
    confidence,
    typical,
    variable,
    last: round2(lastCharge.amount),
    firstDate,
    lastDate: lastCharge.date,
    count: sorted.length,
    stopped,
    flags,
    ids: sorted.map((c) => c.id),
  };
  if (!band) return { ...base, cadence: "unknown", nextDate: null, monthly: null };
  const monthly =
    band.cadence === "weekly"
      ? (typical * 52) / 12
      : band.cadence === "yearly"
        ? typical / 12
        : typical;
  return {
    ...base,
    cadence: band.cadence,
    nextDate: nextDateAfter(lastCharge.date, band.cadence),
    monthly: round2(monthly),
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
  const candidates: Transaction[] = [];
  // Bank lines repeat; name each distinct one once. Null means not a merchant.
  const lines = new Map<string, LineKey | null>();
  for (const tx of transactions) {
    if (tx && typeof tx.date === "string" && tx.date > latest) latest = tx.date;
    if (!isCandidate(tx)) continue;
    candidates.push(tx);
    if (lines.has(tx.description)) continue;
    const generic =
      /\batm\b/i.test(tx.description) || isGenericMerchant(extractMerchant(tx.description));
    lines.set(tx.description, generic ? null : lineKey(tx.description));
  }

  // A short link with no brand on its line belongs to the one brand its other lines name.
  const brandsOf = new Map<string, Set<string>>();
  for (const line of lines.values()) {
    if (!line?.shortLink || line.key === line.shortLink) continue;
    brandsOf.set(line.shortLink, (brandsOf.get(line.shortLink) ?? new Set()).add(line.key));
  }
  const groups = new Map<string, Charge[]>();
  for (const tx of candidates) {
    const line = lines.get(tx.description);
    if (!line?.key) continue;
    const brands = line.key === line.shortLink ? brandsOf.get(line.key) : undefined;
    const key = brands?.size === 1 ? [...brands][0]! : line.key;
    const list = groups.get(key) ?? [];
    list.push({
      id: tx.id,
      date: tx.date,
      amount: Math.abs(tx.amount),
      description: tx.description,
      categoryId: tx.categoryId ?? null,
    });
    groups.set(key, list);
  }

  const asOf = options.today && options.today < latest ? options.today : latest;
  if (!asOf) return { subscriptions: [], hidden: [], totals: totalsOf([]), asOf: "" };
  const asOfDay = dayNumber(asOf);

  const found: Subscription[] = [];
  for (const [key, charges] of groups) {
    const whole = seriesOf(key, charges, asOfDay, "schedule");
    if (whole) {
      found.push(whole);
      continue;
    }
    const rows: Subscription[] = [];
    const covered = new Set<Charge>();
    for (const band of bandsOf(charges)) {
      // A band has to be one price, not a range a busy store's receipts
      // happen to fall into on a schedule.
      const mid = median(band.map((c) => c.amount));
      if (
        band.some((c) => Math.abs(c.amount - mid) > Math.max(BAND_SPREAD * mid, BAND_SPREAD_FLOOR))
      )
        continue;
      const sub = seriesOf(key, band, asOfDay, "schedule");
      if (!sub) continue;
      rows.push(sub);
      for (const c of band) covered.add(c);
    }
    const leftover = charges.filter((c) => c.categoryId === TAGGED && !covered.has(c));
    const unscheduled: Charge[] = [];
    for (const band of bandsOf(leftover)) {
      const sub = seriesOf(key, band, asOfDay, "tagged");
      if (sub?.cadence === "unknown") unscheduled.push(...band);
      else if (sub) rows.push(sub);
    }
    const once = seriesOf(key, unscheduled, asOfDay, "unscheduled");
    if (once) rows.push(once);
    for (const sub of rows) {
      const price = sub.cadence === "unknown" ? "unknown" : Math.round(sub.typical);
      found.push(rows.length > 1 ? { ...sub, key: `${key}|${price}` } : sub);
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
  const rank = (s: Subscription) => (s.stopped ? 2 : s.monthly === null ? 1 : 0);
  const order = (a: Subscription, b: Subscription) =>
    rank(a) - rank(b) || (b.monthly ?? 0) - (a.monthly ?? 0) || a.key.localeCompare(b.key);
  return {
    subscriptions: subscriptions.sort(order),
    hidden: hidden.sort(order),
    totals: totalsOf(subscriptions),
    asOf,
  };
}

function totalsOf(listed: readonly Subscription[]): Record<SubscriptionKind, number> {
  const totals = { subscription: 0, bill: 0, other: 0 };
  for (const s of listed) {
    if (!s.stopped && s.monthly !== null) totals[s.kind] = round2(totals[s.kind] + s.monthly);
  }
  return totals;
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
