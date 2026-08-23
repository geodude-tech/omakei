#!/usr/bin/env node
/**
 * Validate the Omarchy plugin contract on a clean folder that contains only
 * the shell-loaded files. `omarchy plugin add` clones the git tree (no
 * node_modules), so this matches what the installer sees.
 */
import { mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const FILES = ["manifest.json", "BarWidget.qml", "Panel.qml", "Model.js"];

const validate = spawnSync("omarchy-plugin-validate", ["--help"], {
  encoding: "utf8",
});
if (validate.error && validate.error.code === "ENOENT") {
  console.log("skip plugin validate: omarchy-plugin-validate is not on PATH");
  process.exit(0);
}

const stage = mkdtempSync(join(tmpdir(), "omakei-plugin-"));
try {
  for (const file of FILES) {
    cpSync(join(ROOT, file), join(stage, file));
  }
  const result = spawnSync("omarchy-plugin-validate", [stage], {
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
} finally {
  rmSync(stage, { recursive: true, force: true });
}
