#!/usr/bin/env node
/**
 * Fail if the staged `dist/` was not built from the staged sources.
 *
 * `dist/` is committed because installers clone the tree and never build it,
 * so a forgotten `npm run build` ships new source with the old compiled UI and
 * nothing complains. Dev never catches it either: `npm run dev` compiles from
 * source and never reads `dist/`.
 */
import { execFileSync } from "node:child_process";
import { hashIndex, STAMP_PATH } from "./build-inputs.mjs";

function stagedStamp() {
  try {
    return execFileSync("git", ["show", `:${STAMP_PATH}`], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

const want = hashIndex();
if (!want) process.exit(0);

const have = stagedStamp();
if (have === want) process.exit(0);

console.error(
  have === null
    ? `dist/ has never been built (${STAMP_PATH} is missing).`
    : `dist/ is stale — it was built from different sources.\n  staged sources: ${want}\n  dist built from: ${have}`,
);
console.error("\nRebuild and stage it:\n  npm run build && git add dist\n");
console.error("If this commit deliberately leaves dist/ alone, use: git commit --no-verify");
process.exit(1);
