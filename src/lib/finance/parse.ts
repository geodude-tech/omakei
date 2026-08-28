import { fingerprint } from "./fingerprint.ts";
import type { AccountKind, ImportFileResult, ParsedRow } from "./types.ts";

const DATE_HEADERS = [
  "date", "transaction date", "trans date", "trans. date", "posting date",
  "posted date", "post date", "dtposted", "trade date", "effective date",
];
const DESC_HEADERS = [
  "description", "desc", "memo", "payee", "name", "merchant",
  "original description", "transaction", "details", "narrative", "extended details",
];
const AMOUNT_HEADERS = ["amount", "amt", "value", "transaction amount", "sum", "total", "charge"];
const DEBIT_HEADERS = ["debit", "withdrawal", "outflow", "charges", "spent"];
const CREDIT_HEADERS = ["credit", "deposit", "inflow", "payments", "received"];
const SKIP_ROW_HINTS = [
  "beginning balance", "ending balance", "total", "totals", "opening balance", "closing balance",
];

function stripBom(text: string): string {
  return text.replace(/^\uFEFF/, "");
}

function detectDelimiter(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const counts: Record<string, number> = {
    ",": (first.match(/,/g) ?? []).length,
    "\t": (first.match(/\t/g) ?? []).length,
    ";": (first.match(/;/g) ?? []).length,
    "|": (first.match(/\|/g) ?? []).length,
  };
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? ",";
}

export function parseDelimited(text: string, delimiter?: string): string[][] {
  const src = stripBom(text);
  const delim = delimiter ?? detectDelimiter(src);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let i = 0;
  let inQuotes = false;
  while (i < src.length) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delim) {
      row.push(field.trim());
      field = "";
      i += 1;
      continue;
    }
    if (ch === "\n") {
      row.push(field.trim());
      field = "";
      if (row.some((c) => c !== "")) rows.push(row);
      row = [];
      i += 1;
      continue;
    }
    if (ch === "\r") {
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  row.push(field.trim());
  if (row.some((c) => c !== "")) rows.push(row);
  return rows;
}

function looksLikeDate(s: string): boolean {
  if (!s) return false;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return true;
  if (/^\d{8}(\d{6})?$/.test(s)) return true;
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(s)) return true;
  if (/^[A-Za-z]{3,9}\s+\d{1,2},?\s+\d{4}$/.test(s)) return true;
  return false;
}

function parseAmount(s: string): number | null {
  if (!s) return null;
  let t = s.replace(/[\s$,]/g, "").replace(/[\u2013\u2014]/g, "-");
  if (!t || t === "-" || /^n\/?a$/i.test(t)) return null;
  let neg = false;
  if (t.startsWith("(") && t.endsWith(")")) {
    neg = true;
    t = t.slice(1, -1);
  }
  if (t.endsWith("-") && t.length > 1) {
    neg = true;
    t = t.slice(0, -1);
  }
  if (t.startsWith("+")) t = t.slice(1);
  if (t.startsWith("-")) {
    neg = true;
    t = t.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  if (!Number.isFinite(n)) return null;
  return neg ? -n : n;
}

function looksLikeAmount(s: string): boolean {
  return parseAmount(s) !== null;
}

export function parseDate(s: string): string | null {
  // OFX stamps the zone as `20260802120000[-7:MST]`. The bracketed part is
  // never part of the date, and its minus sign used to make the whole value
  // look like a dashed format, which dropped the transaction.
  const t = s.trim().replace(/\[[^\]]*\]$/, "");
  if (!t) return null;
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  // A leading run of 8 digits is unambiguous: ISO is handled above, and the
  // month/day forms below never start with more than four digits.
  const ofx = t.match(/^(\d{4})(\d{2})(\d{2})(?!\d*[/-])/);
  if (ofx) {
    const month = Number(ofx[2]);
    const day = Number(ofx[3]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${ofx[1]}-${ofx[2]}-${ofx[3]}`;
    }
  }
  const us = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (us) {
    const month = Number(us[1]);
    const day = Number(us[2]);
    let year = Number(us[3]);
    if (year < 100) year += year >= 70 ? 1900 : 2000;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  const named = Date.parse(t);
  if (!Number.isNaN(named)) {
    const d = new Date(named);
    if (!Number.isNaN(d.getTime())) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    }
  }
  return null;
}

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[_./]+/g, " ").replace(/\s+/g, " ").trim();
}

function findHeader(headers: string[], aliases: string[]): number {
  const normalized = headers.map(normalizeHeader);
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias);
    if (idx >= 0) return idx;
  }
  for (const alias of aliases) {
    const idx = normalized.findIndex((h) => h === alias || h.startsWith(alias) || h.includes(alias));
    if (idx >= 0) return idx;
  }
  return -1;
}

function rowLooksLikeHeader(cells: string[]): boolean {
  const joined = cells.map(normalizeHeader).join(" ");
  const hits =
    DATE_HEADERS.some((h) => joined.includes(h)) &&
    (DESC_HEADERS.some((h) => joined.includes(h)) || AMOUNT_HEADERS.some((h) => joined.includes(h)));
  if (hits) return true;
  const dateLike = cells.filter(looksLikeDate).length;
  return dateLike === 0 && cells.some((c) => /date|desc|amount|payee/i.test(c));
}

function inferKindFromName(filename: string): AccountKind {
  const n = filename.toLowerCase();
  if (/mortgage|home\s?loan|rocket|quicken loans/.test(n)) return "mortgage";
  if (/amex|american express|visa|mastercard|discover|credit|platinum|sapphire/.test(n)) return "credit";
  if (/saving/.test(n)) return "savings";
  if (/check|bank|checking|chase|wells|bofa|citi/.test(n)) return "checking";
  return "other";
}

function parseOfx(text: string): ParsedRow[] {
  const blocks = text.split(/<STMTTRN>/i).slice(1);
  const rows: ParsedRow[] = [];
  for (const block of blocks) {
    const tag = (name: string) => {
      const re = new RegExp(`<${name}>([^<\\r\\n]+)`, "i");
      return block.match(re)?.[1]?.trim() ?? "";
    };
    const date = parseDate(tag("DTPOSTED"));
    const amount = parseAmount(tag("TRNAMT"));
    const name = tag("NAME") || tag("PAYEE");
    const memo = tag("MEMO");
    const description = [name, memo].filter(Boolean).join(" - ");
    if (!date || amount === null || !description) continue;
    rows.push({ date, description, amount, raw: { date, description, amount: String(amount) } });
  }
  return rows;
}

function scoreColumn(rows: string[][], col: number, test: (s: string) => boolean): number {
  let n = 0;
  for (const row of rows) {
    if (test(row[col] ?? "")) n += 1;
  }
  return n;
}

function mapCsvRows(grid: string[][], filename: string): ImportFileResult {
  const warnings: string[] = [];
  if (grid.length === 0) {
    return {
      filename,
      accountName: filename.replace(/\.[^.]+$/, ""),
      accountKind: inferKindFromName(filename),
      rows: [],
      warnings: ["No rows found"],
    };
  }
  const hasHeader = rowLooksLikeHeader(grid[0] ?? []);
  const headers = hasHeader ? (grid[0] ?? []).map(normalizeHeader) : [];
  const body = hasHeader ? grid.slice(1) : grid;
  const sample = body.slice(0, 24);
  const colCount = Math.max(0, ...grid.map((r) => r.length));
  let dateCol = hasHeader ? findHeader(headers, DATE_HEADERS) : -1;
  let descCol = hasHeader ? findHeader(headers, DESC_HEADERS) : -1;
  let amountCol = hasHeader ? findHeader(headers, AMOUNT_HEADERS) : -1;
  const debitCol = hasHeader ? findHeader(headers, DEBIT_HEADERS) : -1;
  const creditCol = hasHeader ? findHeader(headers, CREDIT_HEADERS) : -1;
  if (dateCol < 0) {
    let best = -1;
    let bestScore = 0;
    for (let c = 0; c < colCount; c++) {
      const score = scoreColumn(sample, c, looksLikeDate);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    dateCol = best;
  }
  if (amountCol < 0 && debitCol < 0 && creditCol < 0) {
    let best = -1;
    let bestScore = 0;
    for (let c = 0; c < colCount; c++) {
      if (c === dateCol) continue;
      const score = scoreColumn(sample, c, looksLikeAmount);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    amountCol = best;
  }
  if (descCol < 0) {
    let best = -1;
    let bestLen = 0;
    for (let c = 0; c < colCount; c++) {
      if (c === dateCol || c === amountCol || c === debitCol || c === creditCol) continue;
      let len = 0;
      for (const row of sample) len += (row[c] ?? "").length;
      if (len > bestLen) {
        bestLen = len;
        best = c;
      }
    }
    descCol = best;
  }
  if (dateCol < 0 || descCol < 0 || (amountCol < 0 && debitCol < 0 && creditCol < 0)) {
    warnings.push("Could not detect date, description, and amount columns.");
  }
  const rows: ParsedRow[] = [];
  for (const cells of body) {
    const desc = (cells[descCol] ?? "").trim();
    if (!desc) continue;
    if (SKIP_ROW_HINTS.some((h) => desc.toLowerCase().includes(h))) continue;
    const date = parseDate(cells[dateCol] ?? "");
    if (!date) continue;
    let amount: number | null = null;
    if (debitCol >= 0 || creditCol >= 0) {
      const debit = parseAmount(cells[debitCol] ?? "") ?? 0;
      const credit = parseAmount(cells[creditCol] ?? "") ?? 0;
      if (debit === 0 && credit === 0 && amountCol >= 0) amount = parseAmount(cells[amountCol] ?? "");
      else amount = credit - Math.abs(debit);
    } else {
      amount = parseAmount(cells[amountCol] ?? "");
    }
    if (amount === null) continue;
    const raw: Record<string, string> = {};
    if (hasHeader) {
      headers.forEach((h, i) => {
        if (h) raw[h] = cells[i] ?? "";
      });
    } else {
      raw.date = cells[dateCol] ?? "";
      raw.description = desc;
      raw.amount = String(amount);
    }
    rows.push({ date, description: desc, amount, raw });
  }
  return {
    filename,
    accountName: filename.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " "),
    accountKind: inferKindFromName(filename),
    rows,
    warnings,
  };
}

function applyKindSign(result: ImportFileResult): ImportFileResult {
  if (result.rows.length === 0) return result;
  const kind = result.accountKind;
  if (kind !== "credit" && kind !== "mortgage") return result;
  const positives = result.rows.filter((r) => r.amount > 0).length;
  const negatives = result.rows.filter((r) => r.amount < 0).length;
  if (kind === "credit" && positives > negatives * 2) {
    return {
      ...result,
      rows: result.rows.map((r) => {
        const desc = r.description.toLowerCase();
        const isPayment = /payment|thank you|pmt received|online pmt/.test(desc);
        return { ...r, amount: isPayment ? Math.abs(r.amount) : -Math.abs(r.amount) };
      }),
    };
  }
  if (kind === "mortgage" && positives > negatives) {
    return { ...result, rows: result.rows.map((r) => ({ ...r, amount: -Math.abs(r.amount) })) };
  }
  return result;
}

export function parseStatementFile(filename: string, text: string): ImportFileResult {
  const trimmed = stripBom(text).trim();
  const lower = filename.toLowerCase();
  const looksOfx =
    lower.endsWith(".ofx") || lower.endsWith(".qfx") || /<OFX>/i.test(trimmed) || /<STMTTRN>/i.test(trimmed);
  let result: ImportFileResult;
  if (looksOfx) {
    const rows = parseOfx(trimmed);
    result = {
      filename,
      accountName: filename.replace(/\.[^.]+$/, ""),
      accountKind: inferKindFromName(filename),
      rows,
      warnings: rows.length === 0 ? ["No OFX transactions found"] : [],
    };
  } else {
    result = mapCsvRows(parseDelimited(trimmed), filename);
  }
  return applyKindSign(result);
}

export function parsedToPreviewKey(row: ParsedRow): string {
  return fingerprint(row.date, row.amount, row.description);
}
