import type { SetAside } from "./types";

const MONTH_RE = /^\d{4}-\d{2}$/;

export type WidgetPreview = {
  month: string;
  spent: number;
  income: number;
  net: number;
  uncategorized: number;
  allocated: number;
  setAsides: SetAside[];
};

/** Query keys shared with Model.js `editorQuery`. */
export const WIDGET_QUERY = {
  month: "m",
  spent: "sp",
  income: "inc",
  net: "n",
  uncategorized: "u",
  reserved: "r",
  setAside: "sa",
} as const;

export function buildWidgetPreviewSearch(preview: WidgetPreview): string {
  const parts = [
    `${WIDGET_QUERY.month}=${encodeURIComponent(preview.month)}`,
    `${WIDGET_QUERY.spent}=${encodeURIComponent(String(preview.spent))}`,
    `${WIDGET_QUERY.income}=${encodeURIComponent(String(preview.income))}`,
    `${WIDGET_QUERY.net}=${encodeURIComponent(String(preview.net))}`,
    `${WIDGET_QUERY.uncategorized}=${encodeURIComponent(String(preview.uncategorized))}`,
  ];
  if (preview.allocated > 0) {
    parts.push(`${WIDGET_QUERY.reserved}=${encodeURIComponent(String(preview.allocated))}`);
  }
  for (const item of preview.setAsides) {
    const name = String(item.name || "").replace(/\t/g, " ");
    parts.push(
      `${WIDGET_QUERY.setAside}=${encodeURIComponent(`${item.id}\t${name}\t${item.amount}`)}`,
    );
  }
  return parts.join("&");
}

export function parseWidgetPreviewSearch(search: string): WidgetPreview | null {
  const raw = search.startsWith("?") ? search.slice(1) : search;
  if (!raw) return null;
  const q = new URLSearchParams(raw);
  const month = q.get(WIDGET_QUERY.month) ?? "";
  if (!MONTH_RE.test(month)) return null;
  if (
    !q.has(WIDGET_QUERY.spent) ||
    !q.has(WIDGET_QUERY.income) ||
    !q.has(WIDGET_QUERY.net)
  ) {
    return null;
  }
  const spent = Number(q.get(WIDGET_QUERY.spent));
  const income = Number(q.get(WIDGET_QUERY.income));
  const net = Number(q.get(WIDGET_QUERY.net));
  if (![spent, income, net].every(Number.isFinite)) return null;
  const uncategorized = Number(q.get(WIDGET_QUERY.uncategorized) ?? "0");
  const allocated = Number(q.get(WIDGET_QUERY.reserved) ?? "0");
  const setAsides: SetAside[] = [];
  for (const entry of q.getAll(WIDGET_QUERY.setAside)) {
    const [id, name, amountRaw] = entry.split("\t");
    if (!id) continue;
    const amount = Number(amountRaw);
    setAsides.push({
      id,
      name: name ?? "",
      amount: Number.isFinite(amount) ? Math.max(0, Math.round(amount * 100) / 100) : 0,
    });
  }
  return {
    month,
    spent,
    income,
    net,
    uncategorized: Number.isFinite(uncategorized) ? Math.max(0, Math.round(uncategorized)) : 0,
    allocated: Number.isFinite(allocated) ? allocated : 0,
    setAsides,
  };
}

export function readWidgetPreviewFromLocation(): WidgetPreview | null {
  if (typeof window === "undefined") return null;
  return parseWidgetPreviewSearch(window.location.search);
}

export function clearWidgetPreviewFromUrl(): void {
  if (typeof window === "undefined" || typeof window.history.replaceState !== "function") {
    return;
  }
  const url = new URL(window.location.href);
  if (!url.searchParams.has(WIDGET_QUERY.month)) return;
  url.search = "";
  window.history.replaceState(null, "", `${url.pathname}${url.hash}`);
}
