#!/usr/bin/env node
/** Record what `dist/` was built from, so a stale build can be spotted later. */
import { writeFileSync } from "node:fs";
import { hashWorkingTree, STAMP_PATH } from "./build-inputs.mjs";

const hash = hashWorkingTree();
if (!hash) {
  console.error("[omakei] no build inputs found — is this a git checkout?");
  process.exit(1);
}
writeFileSync(STAMP_PATH, `${hash}\n`);
console.log(`stamped ${STAMP_PATH} ${hash}`);
