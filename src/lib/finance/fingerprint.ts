const PREFIXES = [
  /^(pos\s+debit|pos|ach\s+(debit|credit|pmt)?|checkcard(\s+\d{4})?|debit card|visa|mastercard|mc |recurring payment|bill pay|online pmt|online payment|purchase authorized on \d{1,2}\/\d{1,2})\s+/i,
  /^(sq\s*\*?|tst\s*\*|sp \*|paypal\s*\*|google\s+\*|facebk\s*\*|fb \*|py \*|med\*)\s*/i,
  /^\d{4}\s+/,
];

const TRAILING_CODES = /\s+(ftm|ach|pos|pmt|debit|credit|purchase|atm)\s*$/i;
const TRAILING_PHONE = /\s+\d{3}[-.]?\d{3}[-.]?\d{4}\b.*$/;
const TRAILING_STATE = /\s+[A-Z]{2}$/;
const TRAILING_LEGAL = /\s+(llc|inc|corp|ltd|co|na)\.?$/i;
const HASH_CODE = /\s+#\d+/g;
const LONG_NUM = /\s+\d{5,}/g;
const STORE_ID = /\s+[A-Za-z]*\d{3,}\b/g;

const WEAK_LEAD = new Set(["the", "sq", "tst"]);

/** Last leftover word after the state code — usually the city. */
const TRAILING_CITY = /\s+[A-Za-z][A-Za-z.'-]*$/;

export function normalizeDescription(description: string): string {
  return spacedForm(description).slice(0, 56);
}

export function spacedForm(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function compactForm(value: string): string {
  return spacedForm(value).replace(/ /g, "");
}

export function extractMerchant(description: string): string {
  let s = description.replace(/\s+/g, " ").trim();
  if (/\batm\b/i.test(s)) return "ATM";
  for (const prefix of PREFIXES) {
    s = s.replace(prefix, "");
  }
  s = s.replace(TRAILING_CODES, "").trim();
  s = s.replace(/([A-Za-z]{3,})\d{2,}/g, "$1");
  s = s.replace(/[-\s]+\d[\d-]+/g, " ").trim();
  s = s.replace(TRAILING_PHONE, "").trim();
  const beforeState = s;
  s = s.replace(TRAILING_STATE, "").trim();
  if (s !== beforeState) s = s.replace(TRAILING_CITY, "").trim();
  s = s.replace(HASH_CODE, " ").replace(LONG_NUM, " ").replace(STORE_ID, " ");
  s = s.replace(TRAILING_LEGAL, "").trim();
  s = s.replace(/\s{2,}/g, " ").trim();
  const tokens = s
    .split(" ")
    .filter((t) => t && t !== "*" && t !== "&" && t !== "-")
    .filter((t, i) => {
      if (!/^\d+$/.test(t)) return true;
      // Keep brand numbers (76) as the key; drop 4+ digit store prefixes.
      return i === 0 && t.length <= 3;
    });
  if (tokens.length === 0) return description.slice(0, 32).trim();
  const first = tokens[0]!.replace(/^\*+|\*+$/g, "");
  if (/^\d{2,3}$/.test(first)) return first;
  if (first.length >= 6 && !WEAK_LEAD.has(first.toLowerCase())) return first;
  if (WEAK_LEAD.has(first.toLowerCase())) return tokens.slice(0, 3).join(" ");
  return tokens.slice(0, 2).join(" ");
}

export function fingerprint(
  date: string,
  amount: number,
  description: string,
): string {
  const cents = Math.round(amount * 100);
  return `${date}|${cents}|${normalizeDescription(description)}`;
}

function escapeRe(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** `/safeway/i` or `/76\\s*-/` — invalid literals are not treated as regex. */
export function parseRegexLiteral(pattern: string): RegExp | null {
  const raw = pattern.trim();
  if (raw.length < 3 || raw[0] !== "/") return null;
  const last = raw.lastIndexOf("/");
  if (last <= 0) return null;
  const body = raw.slice(1, last);
  const flags = raw.slice(last + 1);
  if (!body || /[^gimsuy]/.test(flags)) return null;
  try {
    const merged = `${flags.replace(/g/g, "")}${flags.includes("i") ? "" : "i"}`;
    return new RegExp(body, merged);
  } catch {
    return null;
  }
}

export function identifierLength(pattern: string): number {
  const literal = parseRegexLiteral(pattern);
  if (literal) return literal.source.replace(/\\/g, "").length;
  return compactForm(pattern).length;
}

/** Consecutive tokens whose letters concatenate to the identifier (WAL-MART → walmart). */
function compactSpanMatch(needle: string, description: string): boolean {
  const want = compactForm(needle);
  if (want.length < 4) return false;
  const toks = spacedForm(description).split(" ").filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    let acc = "";
    for (let j = i; j < toks.length; j++) {
      acc += toks[j];
      if (acc === want) return true;
      if (acc.length > want.length) break;
    }
  }
  return false;
}

type CompiledRule = {
  literal: RegExp | null;
  tokenRe: RegExp | null;
};

const compiledRules = new Map<string, CompiledRule>();

function compileRule(pattern: string): CompiledRule | null {
  const raw = pattern.trim();
  if (!raw) return null;
  const hit = compiledRules.get(raw);
  if (hit) return hit;

  const literal = parseRegexLiteral(raw);
  if (literal) {
    const compiled = { literal, tokenRe: null };
    compiledRules.set(raw, compiled);
    return compiled;
  }

  const spacedNeedle = spacedForm(raw);
  if (!spacedNeedle) {
    const compiled = { literal: null, tokenRe: null };
    compiledRules.set(raw, compiled);
    return compiled;
  }

  const tokens = spacedNeedle.split(" ").filter(Boolean);
  const body = tokens.map(escapeRe).join("\\s+");
  const glue = compactForm(raw).length >= 6 ? "[a-z0-9]*" : "\\d*";
  const compiled = {
    literal: null,
    tokenRe: new RegExp(`(?:^|\\s)${body}${glue}(?=\\s|$)`),
  };
  compiledRules.set(raw, compiled);
  return compiled;
}

let spacedDescKey = "";
let spacedDescVal = "";

function spacedDescription(description: string): string {
  if (description === spacedDescKey) return spacedDescVal;
  spacedDescKey = description;
  spacedDescVal = spacedForm(description);
  return spacedDescVal;
}

/**
 * Match a key identifier against a bank description.
 * Case-insensitive; town, store #, and punctuation are ignored.
 * `safeway` hits every Safeway. Wrap in /slashes/ for a real regex.
 */
export function ruleMatches(pattern: string, description: string): boolean {
  const compiled = compileRule(pattern);
  if (!compiled) return false;
  if (compiled.literal) {
    return compiled.literal.test(description) || compiled.literal.test(spacedDescription(description));
  }
  if (!compiled.tokenRe) return false;
  if (compiled.tokenRe.test(spacedDescription(description))) return true;
  return compactSpanMatch(pattern, description);
}
