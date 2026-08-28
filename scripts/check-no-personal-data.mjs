#!/usr/bin/env node
/**
 * Fail if personal information would enter git.
 *
 * `check-no-statements.mjs` blocks whole files by name — a statement dump, a
 * ledger. This one reads content, because the likelier leak is a real card
 * number pasted into a test fixture or a home address left in a comment.
 *
 * What it can and cannot do: the patterns below match data with a recognisable
 * shape. Nothing here can tell that a merchant, a balance, or a family name is
 * *yours* — that rule lives in AGENTS.md and is enforced by review. For terms
 * only this machine knows, put them one per line in `.githooks/personal-terms`,
 * which is gitignored precisely so the block list is not itself a leak.
 *
 *   node scripts/check-no-personal-data.mjs            # audit every tracked file
 *   node scripts/check-no-personal-data.mjs --staged   # what this commit adds
 *
 * A line that must keep a matching string carries `omakei:allow-personal`, on
 * that line or the one above it.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

const PRAGMA = "omakei:allow-personal";
const TERMS_FILE = ".githooks/personal-terms";
const MAX_BYTES = 5_000_000;

/* Domains that are reserved for documentation, or are not real mailboxes. */
const SAFE_EMAIL = /@(example\.(com|org|net)|test|localhost|invalid|sentry\.io|noreply\.[\w.]+)$/i;
const SAFE_EMAIL_LOCAL = /^(you|user|someone|name|email|test|noreply|no-reply)@/i;

/* Real IBAN country prefixes, so a base64 hash cannot masquerade as one. */
const IBAN_COUNTRIES =
  "AD|AE|AT|BE|BG|CH|CY|CZ|DE|DK|EE|ES|FI|FR|GB|GI|GR|HR|HU|IE|IL|IS|IT|LI|LT|LU|LV|MC|MT|NL|NO|PL|PT|RO|SE|SI|SK|SM|TR";

function luhn(digits) {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** True when the digits open with a real card issuer prefix at that issuer's length. */
function issuerLength(d) {
  const n = d.length;
  if (d.startsWith("4")) return n === 13 || n === 16 || n === 19;
  if (/^5[1-5]/.test(d) || /^2(2[2-9]|[3-6]\d|7[01])/.test(d)) return n === 16;
  if (/^3[47]/.test(d)) return n === 15;
  if (/^6(011|5\d|4[4-9])/.test(d)) return n === 16 || n === 19;
  if (/^35(2[89]|[3-8]\d)/.test(d)) return n === 16;
  return false;
}

function aba(digits) {
  const d = [...digits].map(Number);
  const sum =
    3 * (d[0] + d[3] + d[6]) + 7 * (d[1] + d[4] + d[7]) + (d[2] + d[5] + d[8]);
  return sum % 10 === 0;
}

export const RULES = [
  {
    name: "payment card number",
    // Luhn alone is not enough: an OFX timestamp like 20260804120000 passes it.
    // Requiring a real issuer prefix and one of that issuer's lengths is what
    // separates a card from any other run of digits.
    re: /\b(?:\d[ -]?){12,18}\d\b/g,
    accept: (m) => {
      const d = m.replace(/[ -]/g, "");
      return issuerLength(d) && luhn(d) && !/^(\d)\1+$/.test(d);
    },
  },
  {
    name: "US Social Security number",
    re: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    name: "bank routing number",
    re: /\b\d{9}\b/g,
    // Nine digits are common; the ABA checksum plus nearby wording is what
    // makes this a routing number rather than a coincidence. The wording has to
    // be *near* the digits — on one line of minified JS, "anywhere on the line"
    // means anywhere in the bundle, and 0x7FFFFFF passes the checksum.
    accept: (m, ctx) => aba(m) && /routing|aba|rtn|wire|transit/i.test(ctx),
  },
  {
    name: "account number",
    re: /\b(?:account|acct|a\/c|routing|iban|sort code)\b[^\n]{0,20}?\b\d{6,}\b/gi,
  },
  {
    name: "IBAN",
    re: new RegExp(`\\b(?:${IBAN_COUNTRIES})\\d{2}[A-Z0-9]{11,30}\\b`, "g"),
  },
  {
    name: "email address",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    accept: (m) => !SAFE_EMAIL.test(m) && !SAFE_EMAIL_LOCAL.test(m),
  },
  {
    name: "phone number",
    re: /(?:\(\d{3}\)\s*\d{3}[-.\s]\d{4}|\b\d{3}[-.]\d{3}[-.]\d{4}\b)/g,
    // Statement descriptions carry the merchant's support line. A toll-free
    // number is a company's, and the fixtures are full of them by design.
    accept: (m) => !/^\(?(800|833|844|855|866|877|888)\)?[-.\s]/.test(m),
  },
  {
    name: "street address",
    re: /\b\d{1,5}\s+(?:[A-Z][A-Za-z.]*\s+){1,3}(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd|Court|Ct|Circle|Cir|Terrace|Ter|Place|Pl|Way|Highway|Hwy)\b\.?/g,
  },
];

function localTerms() {
  if (!existsSync(TERMS_FILE)) return null;
  const words = readFileSync(TERMS_FILE, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (words.length === 0) return null;
  return {
    name: "term from .githooks/personal-terms",
    re: new RegExp(`(?<![\\w-])(?:${words.join("|")})(?![\\w-])`, "gi"),
    redact: true,
  };
}

function git(args, opts = {}) {
  return execFileSync("git", args, { encoding: "buffer", maxBuffer: 1 << 28, ...opts });
}

function stagedFiles() {
  return git(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACM"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
}

function trackedFiles() {
  return git(["ls-files", "-z"]).toString("utf8").split("\0").filter(Boolean);
}

function contentOf(path, staged) {
  try {
    return staged ? git(["show", `:${path}`]) : readFileSync(path);
  } catch {
    return null; // deleted, or unreadable; nothing to scan
  }
}

/** The rule set, plus any terms this machine keeps privately. */
export function buildRules() {
  const rules = [...RULES];
  const terms = localTerms();
  if (terms) rules.push(terms);
  return rules;
}

/** Scan text and return every hit. Exported so the rules can be tested directly. */
export function scanText(text, rules = buildRules()) {
  const hits = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    // The pragma exempts the line it is on, or the line after it — so it can be
    // a trailing comment or sit above a long statement, as eslint's does.
    if (line.includes(PRAGMA) || lines[i - 1]?.includes(PRAGMA)) return;
    for (const rule of rules) {
      rule.re.lastIndex = 0;
      let m;
      while ((m = rule.re.exec(line)) !== null) {
        const ctx = line.slice(Math.max(0, m.index - 64), m.index + m[0].length + 64);
        if (rule.accept && !rule.accept(m[0], ctx)) continue;
        hits.push({
          line: i + 1,
          rule: rule.name,
          // Never print the value of a term the user asked to keep private.
          match: rule.redact ? "[redacted]" : m[0].slice(0, 60),
        });
      }
    }
  });
  return hits;
}

/**
 * The scanner's own tests must contain the things the scanner looks for. Every
 * value in there is a published test vector — the card networks' test numbers,
 * the 555 fictional phone range, the IBAN from the standard's own examples —
 * and none of it is anybody's. This is the only whole-file exemption; use the
 * per-line pragma for everything else.
 */
const SELF_TEST = "scripts/check-no-personal-data.test.mjs";

function scanFile(path, buf, rules) {
  if (path === SELF_TEST) return [];
  if (buf.length > MAX_BYTES) return [];
  // A NUL in the head is git's own binary heuristic. Images and fonts have
  // nothing to read and would only produce noise.
  if (buf.subarray(0, 8000).includes(0)) return [];

  return scanText(buf.toString("utf8"), rules).map((h) => ({ ...h, path }));
}

function main() {
const staged = process.argv.includes("--staged");
const rules = buildRules();

const files = staged ? stagedFiles() : trackedFiles();
const hits = [];
for (const path of files) {
  const buf = contentOf(path, staged);
  if (buf) hits.push(...scanFile(path, buf, rules));
}

if (hits.length > 0) {
  console.error(
    staged
      ? "Refusing to commit what looks like personal information:"
      : "Tracked files contain what looks like personal information:",
  );
  for (const h of hits) {
    console.error(`  ${h.path}:${h.line}  ${h.rule}: ${h.match}`);
  }
  console.error(
    `\nReplace it with an invented value. If the match is genuinely not personal,\n` +
      `put ${PRAGMA} in a comment on that line.`,
  );
  process.exit(1);
}
}

if (process.argv[1]?.endsWith("check-no-personal-data.mjs")) main();
