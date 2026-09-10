#!/usr/bin/env node
/**
 * Run the widget's QML for real and fail if it misbehaves.
 *
 * `Model.js` has always been testable in Node, but the `.qml` around it was
 * hand-verification only — and the first thing this caught was a plugin that
 * would not load at all: outside the shell's config root, a sibling `.qml` is
 * not implicitly a type, so `Panel.qml` failed to compile the moment the
 * section moved into its own file.
 *
 * How it works: quickshell renders offscreen, so no compositor and no window on
 * anyone's screen. `qml-harness/scene.qml` is staged in a temp directory next
 * to symlinks of the plugin's own files and of the omarchy shell's `Commons`
 * and `Ui`, which is what makes `qs.Ui` resolve. HOME and XDG_STATE_HOME point
 * at a throwaway ledger, so the writes the harness makes are real writes by the
 * real CLI against a file that is deleted at the end.
 *
 * Skips, rather than fails, where quickshell or the omarchy shell is absent.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderStateFile } from "./ledger-api.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SHELL = "/usr/share/omarchy/shell";
const TIMEOUT_MS = 60_000;
/** quickshell colours its log lines; the escape has to be built, not typed. */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function skip(why) {
  console.log(`skip qml check: ${why}`);
  process.exit(0);
}

if (spawnSync("quickshell", ["--version"], { encoding: "utf8" }).error) {
  skip("quickshell is not on PATH");
}
try {
  readFileSync(join(SHELL, "Ui", "qmldir"));
} catch {
  skip(`${SHELL} is not installed`);
}

const stage = mkdtempSync(join(tmpdir(), "omakei-qml-"));
try {
  // The config root: the harness scene plus everything it imports.
  for (const dir of ["Commons", "Ui", "services"]) symlinkSync(join(SHELL, dir), join(stage, dir));
  for (const file of ["NeedsCategory.qml", "Model.js"]) {
    symlinkSync(join(ROOT, file), join(stage, file));
  }

  const home = join(stage, "home");
  const statements = join(home, "Statements");
  const stateDir = join(home, ".local", "state", "omakei");
  mkdirSync(statements, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "state.json"), renderStateFile(statements));
  writeFileSync(join(statements, "omakei-ledger.json"), JSON.stringify(ledger()));

  const scene = readFileSync(join(ROOT, "qml-harness", "scene.qml"), "utf8")
    .replace("@REPO@", ROOT)
    .replace("@STATEMENTS@", statements);
  writeFileSync(join(stage, "shell.qml"), scene);

  const run = spawnSync("quickshell", ["-p", join(stage, "shell.qml")], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    cwd: stage,
    env: {
      ...process.env,
      HOME: home,
      XDG_STATE_HOME: join(home, ".local", "state"),
      QT_QPA_PLATFORM: "offscreen",
    },
  });

  // quickshell colours and prefixes its log lines; the harness's own lines are
  // the only ones worth reading.
  const lines = `${run.stdout ?? ""}${run.stderr ?? ""}`
    .split("\n")
    .map((l) => l.replace(ANSI, ""))
    .filter((l) => l.includes("qml:"))
    .map((l) => l.replace(/^.*?\bqml:\s?/, ""));

  for (const line of lines) console.log(line.trimEnd());

  const failed = lines.filter((l) => l.trim().startsWith("FAIL"));
  const done = lines.some((l) => l.includes("HARNESS DONE"));
  if (!done) {
    console.error(`qml check: the harness did not finish (exit ${run.status ?? "timeout"})`);
    process.exit(1);
  }
  if (failed.length > 0) process.exit(1);

  // The harness said it wrote; check the file it wrote to, from out here.
  const written = JSON.parse(readFileSync(join(statements, "omakei-ledger.json"), "utf8"));
  const rules = written.rules.map((r) => `${r.pattern}=${r.categoryId}`).sort();
  const expected = ["PORCH SUPPLY=groceries", "ZORP WIDGETS=shopping"];
  if (rules.join() !== expected.join()) {
    console.error(`qml check: the popup wrote ${JSON.stringify(rules)}, expected ${JSON.stringify(expected)}`);
    process.exit(1);
  }
  console.log(`qml check: ${lines.filter((l) => l.trim().startsWith("PASS")).length} checks passed`);
} finally {
  rmSync(stage, { recursive: true, force: true });
}

function ledger() {
  const tx = (id, description, amount) => ({
    id,
    date: "2026-08-10",
    description,
    amount,
    accountName: "checking",
    accountKind: "checking",
    sourceFile: "f.csv",
    fingerprint: `fp:${id}`,
    categoryId: null,
    importedAt: 0,
  });
  return {
    version: 1,
    selectedMonth: "2026-08",
    rules: [],
    transactions: [
      tx("a", "ZORP WIDGETS 5567", -12.5),
      tx("b", "ZORP WIDGETS 1180 SEATTLE WA", -30),
      tx("c", "SQ *PORCH SUPPLY SEATTLE WA", -80),
      tx("d", "QUUX BRAVO SUPPLY", -5),
      tx("e", "A VERY LONG MERCHANT NAME THAT KEEPS GOING AND GOING", -3),
    ],
  };
}
