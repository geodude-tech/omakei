#!/usr/bin/env node
/**
 * Fail if git would track personal statement dumps.
 */
import { execFileSync } from "node:child_process";

const BLOCKED = /\.(csv|tsv|ofx|qfx|ofc)$/i;
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
