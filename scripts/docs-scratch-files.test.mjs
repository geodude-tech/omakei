/**
 * The docs are instructions an agent follows against the user's ledger. A
 * command that redirects into a fixed name under `/tmp` leaves the output
 * readable by every account on the machine under the default umask, which
 * omarchy-plugin-marketplace#7136 flagged in the categorize runbook. Ledger
 * output belongs in a `mktemp -d` directory instead.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const SHARED_WRITE = /(?:>>?|\btee\b(?:\s+-a)?)\s*["']?(?:\/tmp\/|\/var\/tmp\/|\$\{?TMPDIR)/;

test("no doc writes into a shared temp directory", () => {
  const docs = execFileSync("git", ["ls-files", "-z", "--", "*.md"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
  assert.ok(docs.length > 0);
  const hits = [];
  for (const file of docs) {
    readFileSync(join(ROOT, file), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (SHARED_WRITE.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      });
  }
  assert.deepEqual(hits, []);
});
