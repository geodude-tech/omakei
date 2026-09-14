#!/usr/bin/env node
/**
 * Fail if git would track personal statement dumps.
 */
import { execFileSync } from "node:child_process";

// `.pdf` is here even though the importer cannot read one: a statement folder
// holds PDFs regardless, and `omakei-convert-boa-pdf.mjs` reads one on purpose.
const BLOCKED = /\.(csv|tsv|ofx|qfx|ofc|pdf)$/i;
// `folio-ledger.json` is what an early build wrote; still blocked so an old
// one cannot be committed by accident.
const BLOCKED_PATH =
  /(^|\/)(Financial_Statements|statements|data\/statements)(\/|$)|(folio|omakei)-ledger\.json$/i;

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer" })
  .toString("utf8")
  .split("\0")
  .filter(Boolean);

const bad = tracked.filter((f) => BLOCKED.test(f) || BLOCKED_PATH.test(f));
if (bad.length > 0) {
  console.error("Refusing to keep personal statement files in git:");
  for (const f of bad) console.error(`  ${f}`);
  process.exit(1);
}
