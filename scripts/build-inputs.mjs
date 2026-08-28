/**
 * What `dist/` is built from.
 *
 * Staleness is detected by comparing git blob hashes rather than mtimes, so a
 * fresh clone or a branch switch does not read as stale. `git hash-object` on
 * the working tree and the index's own hashes agree exactly, which lets the
 * build stamp and the pre-commit check compare like for like.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

/**
 * What the build reads. QML and the server scripts run as source, so they are
 * not here — except `page-shell.mjs`, whose class names Tailwind scans (see
 * the `@source` lines in `src/styles.css`), so editing it changes the CSS.
 */
export const BUILD_INPUT_PATHS = [
  "src",
  "index.html",
  "vite.config.ts",
  "scripts/page-shell.mjs",
];

export const STAMP_PATH = "dist/.build-hash";

const IGNORED = /\.test\.(ts|tsx|mjs)$/;

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function trackedInputs() {
  return git(["ls-files", "-z", "--", ...BUILD_INPUT_PATHS])
    .split("\0")
    .filter((f) => f && !IGNORED.test(f))
    .sort();
}

/** `path <blob-sha>` per line — the same text whichever side computes it. */
function digest(lines) {
  return createHash("sha256").update(lines.join("\n")).digest("hex").slice(0, 40);
}

/** Hash the files as they exist on disk (build time). */
export function hashWorkingTree() {
  const files = trackedInputs();
  if (files.length === 0) return null;
  const out = execFileSync("git", ["hash-object", "--stdin-paths"], {
    encoding: "utf8",
    input: files.join("\n") + "\n",
  })
    .trim()
    .split("\n");
  return digest(files.map((f, i) => `${f} ${out[i]}`));
}

/** Hash the files as they are staged (pre-commit time). */
export function hashIndex() {
  const rows = git(["ls-files", "-s", "-z", "--", ...BUILD_INPUT_PATHS])
    .split("\0")
    .filter(Boolean)
    .map((row) => {
      const [meta, path] = row.split("\t");
      const [, sha] = meta.split(/\s+/);
      return { path, sha };
    })
    .filter((r) => !IGNORED.test(r.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (rows.length === 0) return null;
  return digest(rows.map((r) => `${r.path} ${r.sha}`));
}
