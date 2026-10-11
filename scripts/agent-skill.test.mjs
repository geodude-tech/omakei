/**
 * `skills/omakei/SKILL.md` is what an agent follows on a fresh install, so a
 * renamed script, a dropped flag, a moved doc, or a changed category set has
 * to fail `npm test` instead of sending the agent down a dead path.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CATEGORIES } from "../src/lib/finance/categories.ts";
import { findSubscriptions } from "../src/lib/finance/subscriptions.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKILL = join(ROOT, "skills/omakei/SKILL.md");
const ENTRY_POINTS = [SKILL, join(ROOT, "AGENTS.md")];
const skill = readFileSync(SKILL, "utf8");

const codeSpans = (text) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]);

function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(m, "SKILL.md starts with a --- frontmatter block");
  return Object.fromEntries(
    m[1].split("\n").map((line) => {
      const i = line.indexOf(":");
      return [line.slice(0, i).trim(), line.slice(i + 1).trim()];
    }),
  );
}

const slug = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9 -]/g, "")
    .replace(/ /g, "-");

test("the skill's frontmatter has a name matching its folder and a description", () => {
  const fm = frontmatter(skill);
  assert.deepEqual(Object.keys(fm).sort(), ["description", "name"]);
  assert.equal(fm.name, "omakei");
  assert.ok(fm.description.length > 0 && fm.description.length <= 1024);
});

test("every link in the agent entry points resolves to a file and heading", () => {
  for (const file of ENTRY_POINTS) {
    const text = readFileSync(file, "utf8");
    for (const [, target] of text.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^https?:/.test(target)) continue;
      const [path, anchor] = target.split("#");
      const abs = resolve(dirname(file), path);
      assert.ok(existsSync(abs), `${file}: ${target} does not exist`);
      if (!anchor) continue;
      const headings = [...readFileSync(abs, "utf8").matchAll(/^#+ (.+)$/gm)].map((h) =>
        slug(h[1]),
      );
      assert.ok(headings.includes(anchor), `${file}: ${target} names no heading`);
    }
  }
});

test("every repository path the skill names exists", () => {
  const paths = codeSpans(skill).flatMap(
    (span) => span.match(/\b(?:scripts|src|docs)\/[\w./-]+/g) ?? [],
  );
  assert.ok(paths.length > 0);
  for (const path of paths) assert.ok(existsSync(join(ROOT, path)), `${path} does not exist`);
});

test("every command the skill gives runs and reaches the ledger lookup", () => {
  const commands = codeSpans(skill).filter((span) => span.startsWith("node scripts/"));
  assert.ok(commands.length >= 6);
  const sandbox = mkdtempSync(join(tmpdir(), "omakei-skill-"));
  try {
    for (const command of commands) {
      const [, ...args] = command.split(" ");
      const run = spawnSync(process.execPath, args, {
        cwd: ROOT,
        encoding: "utf8",
        env: { PATH: process.env.PATH, HOME: sandbox, XDG_STATE_HOME: join(sandbox, "state") },
      });
      assert.match(
        run.stdout + run.stderr,
        /No folder is attached|No readable ledger|No ledger found|No statements folder attached/,
        `${command} was rejected before it looked for a ledger`,
      );
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

function documentedCategories(word) {
  const row = skill.match(new RegExp(`^\\| ${word} +\\|[^|]*\\|([^|]*)\\|$`, "m"));
  assert.ok(row, `the recurring table has a ${word} row`);
  return codeSpans(row[1]).sort();
}

function kindOf(categoryId, accountKind = "checking") {
  const transactions = ["2026-05-03", "2026-06-03", "2026-07-03", "2026-08-03"].map((date, i) => ({
    id: `t${i}`,
    date,
    description: "ZORP RECURRING",
    amount: -40,
    accountName: "Checking",
    accountKind,
    sourceFile: "s.csv",
    fingerprint: `f${i}`,
    categoryId,
    importedAt: 0,
  }));
  return findSubscriptions(transactions, { today: "2026-08-10" }).subscriptions[0]?.kind;
}

test("the recurring table names the categories the finder sorts into each group", () => {
  const ids = CATEGORIES.map((c) => c.id);
  const kinds = new Map(ids.map((id) => [id, kindOf(id)]));
  const named = (kind) => ids.filter((id) => kinds.get(id) === kind).sort();
  assert.deepEqual(documentedCategories("Subscriptions"), named("subscription"));
  assert.deepEqual(documentedCategories("Bills"), named("bill"));
  assert.match(skill, /^\| Bills +\|.*every payment from a mortgage account/m);
  assert.equal(kindOf(null, "mortgage"), "bill", "an uncategorized mortgage payment is a bill");
});
