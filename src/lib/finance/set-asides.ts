import type { SetAside } from "./types.ts";

export function makeSetAside(name = "", amount = 0): SetAside {
  return {
    id: crypto.randomUUID(),
    name,
    amount: roundMoney(amount),
  };
}

export function parseSetAsides(raw: unknown): SetAside[] {
  if (!Array.isArray(raw)) return [];
  const out: SetAside[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Partial<SetAside>;
    if (typeof rec.id !== "string" || rec.id.length === 0) continue;
    const name = typeof rec.name === "string" ? rec.name : "";
    const amount = typeof rec.amount === "number" && Number.isFinite(rec.amount) ? rec.amount : 0;
    out.push({ id: rec.id, name, amount: roundMoney(Math.max(0, amount)) });
  }
  return out;
}

export function setAsideTotal(setAsides: SetAside[]): number {
  let total = 0;
  for (const item of setAsides) total += item.amount;
  return roundMoney(total);
}

export function availableNet(cashflow: number, setAsides: SetAside[]): number {
  return roundMoney(cashflow - setAsideTotal(setAsides));
}

/** Parse a typed dollar amount. Empty input is 0. Invalid input returns null. */
export function parseMoneyInput(raw: string): number | null {
  const cleaned = raw.trim().replace(/[$,\s]/g, "").replace(/[−–—]/g, "-");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return 0;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return roundMoney(Math.abs(n));
}

export function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}
