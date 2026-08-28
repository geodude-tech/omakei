#!/usr/bin/env node
/**
 * Fail if a panel does not match the contract in `src/panels/README.md`.
 *
 * This is a text check rather than an import: panels are `.tsx`, and
 * `node --experimental-strip-types` cannot strip JSX, so the test runner cannot
 * load them. It is coarse, and deliberately so — its job is to catch the
 * mistakes an agent actually makes (a missing `meta`, a stray write to the
 * ledger) at `npm test` rather than in the browser. The registry repeats these
 * checks at runtime and drops anything malformed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const DIR = "src/panels";
const problems = [];

const files = readdirSync(DIR).filter((f) => f.endsWith(".tsx"));

for (const file of files) {
  const src = readFileSync(join(DIR, file), "utf8");
  const where = `${DIR}/${file}`;

  if (!/^export default function \w+/m.test(src)) {
    problems.push(`${where}: needs a named \`export default function\` component.`);
  }

  const meta = /^export const meta(?:: PanelMeta)? = \{([^}]*)\}/m.exec(src);
  if (!meta) {
    problems.push(`${where}: needs \`export const meta: PanelMeta = { title: "..." }\`.`);
    continue;
  }

  const body = meta[1];
  if (!/title:\s*"[^"]+"/.test(body)) {
    problems.push(`${where}: \`meta.title\` must be a non-empty string literal.`);
  }

  const span = /span:\s*(\d+)/.exec(body);
  if (span && !["1", "2", "3", "4", "5"].includes(span[1])) {
    problems.push(`${where}: \`meta.span\` is ${span[1]}; the grid is five columns wide.`);
  }

  // Panels render; they never write. Reaching the store is the one way a panel
  // could mutate the ledger, so that import is the line to hold.
  if (/from "@\/lib\/finance\/store/.test(src)) {
    problems.push(`${where}: panels are read-only and must not import the ledger store.`);
  }
}

if (problems.length > 0) {
  console.error("Panel contract violations:");
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
