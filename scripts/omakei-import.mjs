#!/usr/bin/env node
/**
 * Import whatever new statements have landed in the attached folder, once,
 * and exit:
 *
 *   omakei-import.mjs [--notify] [--rescan] [--json] [--settle <seconds>]
 *   omakei-import.mjs --status
 *
 * Bank of America PDFs go through the existing converter's parser; CSV, TSV,
 * OFX, and QFX through the editor's own parser and merge, so ids, dedupe, and
 * categories come out exactly as a sync from the editor would make them. A
 * file already read (same sha256) is skipped, so running this every few
 * minutes costs a directory walk and a hash. `--notify` sends a desktop
 * notification with counts only. `--status` lists what has been read.
 *
 * Meant to be run by a systemd user timer (docs/spec/auto-import.md), but safe
 * to run by hand at any time, alongside the editor or another run.
 *
 * What it will not do: follow a symlink, read a file still being written,
 * write anything into the statements folder, write outside the private state
 * directory, put a filename or amount on any command line, or touch the
 * network.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants as FS,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  MAX_STATE_BYTES,
  bumpRevisionAt,
  parseStateFile,
  prepareLedgerDir,
  readCapped,
  stateDirFor,
} from "./ledger-api.mjs";
import { readLedgerDb, updateLedgerDb } from "./ledger-db.mjs";
import { parseBoaStatement, toCsv, UnrecognizedStatement } from "./omakei-convert-boa-pdf.mjs";
import {
  REASONS,
  SETTLE_MS,
  applyImport,
  isImportable,
  noticeText,
  planFiles,
  seenHashes,
} from "../src/lib/finance/auto-import.ts";
import { parseStatementAtPath } from "../src/lib/finance/statements.ts";

const MAX_DEPTH = 4;
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 32 * 1024 * 1024;
const PDFTOTEXT_TIMEOUT_MS = 30_000;
const LOCK_NAME = "import.lock";
const STALE_LOCK_MS = 30 * 60 * 1000;

/**
 * Filenames are the user's, but a name can carry terminal escapes or
 * right-to-left overrides; keep both off the terminal.
 */
const printable = (text) =>
  // eslint-disable-next-line no-control-regex
  String(text).replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "?");

/* ------------------------------------------------------------------ lock */

function readLock(path) {
  let fd;
  try {
    fd = openSync(path, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(64);
    const n = readSync(fd, buf, 0, 64, 0);
    const [pid, at] = buf.subarray(0, n).toString("utf8").trim().split(/\s+/).map(Number);
    return Number.isInteger(pid) && pid > 0 ? { pid, at: at || 0 } : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * One run at a time. `O_EXCL` makes taking the lock atomic; a lock whose
 * process is gone, or that is older than any run could take, is removed and
 * taken once more. The ledger's own write transaction is the second line, so a
 * lost race here costs a wasted pass, never a double import.
 */
export function takeLock(stateDir, now = Date.now()) {
  const path = join(stateDir, LOCK_NAME);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
      try {
        writeSync(fd, `${process.pid} ${now}\n`);
      } finally {
        closeSync(fd);
      }
      return () => {
        if (readLock(path)?.pid === process.pid) {
          try {
            unlinkSync(path);
          } catch {
            /* already gone */
          }
        }
      };
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      const held = readLock(path);
      if (held && alive(held.pid) && now - held.at < STALE_LOCK_MS) return null;
      try {
        unlinkSync(path);
      } catch {
        /* someone else cleared it */
      }
    }
  }
  return null;
}

/* ------------------------------------------------------------------ scan */

/** Statement files under `root`, never following a link, bounded in depth and count. */
export function scanFolder(root) {
  const found = [];
  const walk = (dirAbs, rel, depth) => {
    let entries;
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (found.length >= MAX_FILES) return;
      if (entry.name.startsWith(".")) continue;
      const relPath = rel ? `${rel}/${entry.name}` : entry.name;
      // Dirent types come from the directory itself: a symlink is neither a
      // file nor a directory here, so it is never followed.
      if (entry.isDirectory()) {
        if (depth < MAX_DEPTH) walk(join(dirAbs, entry.name), relPath, depth + 1);
        continue;
      }
      if (!entry.isFile() || !isImportable(relPath)) continue;
      let info;
      try {
        info = lstatSync(join(dirAbs, entry.name));
      } catch {
        continue;
      }
      if (info.isFile()) found.push({ path: relPath, size: info.size, mtimeMs: info.mtimeMs });
    }
  };
  walk(root, "", 0);
  return found;
}

/* ------------------------------------------------------------------ read */

/**
 * Open `rel` under `root` one component at a time, each `O_NOFOLLOW` through
 * its parent's descriptor, so a folder swapped for a link after the scan
 * cannot redirect the read. `root` itself may be a link (statements kept on
 * another drive); it resolves once.
 */
function openUnder(root, rel) {
  const parts = rel.split("/");
  const name = parts.pop();
  let dfd = openSync(root, FS.O_RDONLY | FS.O_DIRECTORY);
  try {
    for (const part of parts) {
      const next = openSync(
        `/proc/self/fd/${dfd}/${part}`,
        FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW,
      );
      closeSync(dfd);
      dfd = next;
    }
    return openSync(`/proc/self/fd/${dfd}/${name}`, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  } finally {
    closeSync(dfd);
  }
}

/**
 * The file's bytes and an open descriptor to them, or a reason to leave it for
 * the next run. A size or mtime that moved since the scan, or during the read,
 * means it is still being written.
 */
function readStable(root, file) {
  let fd;
  try {
    fd = openUnder(root, file.path);
  } catch {
    return { skip: "gone or not a plain file" };
  }
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) return { skip: "not a plain file" };
    if (before.size > MAX_FILE_BYTES) return { skip: "over 32 MB" };
    if (before.size !== file.size || before.mtimeMs !== file.mtimeMs)
      return { skip: "still changing" };
    const bytes = Buffer.alloc(before.size);
    let read = 0;
    while (read < bytes.length) {
      const n = readSync(fd, bytes, read, bytes.length - read, read);
      if (n === 0) break;
      read += n;
    }
    const after = fstatSync(fd);
    if (read !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      return { skip: "still changing" };
    }
    const result = { fd, bytes };
    fd = undefined;
    return result;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * A PDF's text, from the descriptor already open and checked. `pdftotext`
 * opens it as /dev/fd/3, so no filename reaches its command line and the file
 * is not looked up by name again.
 */
function pdfText(fd) {
  const run = spawnSync("pdftotext", ["-layout", "/dev/fd/3", "-"], {
    stdio: ["ignore", "pipe", "pipe", fd],
    encoding: "utf8",
    maxBuffer: MAX_FILE_BYTES,
    timeout: PDFTOTEXT_TIMEOUT_MS,
  });
  if (run.error?.code === "ENOENT") return { missingTool: true };
  if (run.error || run.status !== 0) return { text: null };
  return { text: run.stdout };
}

function parseFile(file, read) {
  const lower = file.path.toLowerCase();
  if (lower.endsWith(".pdf")) {
    const { text, missingTool } = pdfText(read.fd);
    if (missingTool) return { skip: "pdftotext is not installed (poppler)" };
    if (text === null) return { reason: REASONS.unrecognized };
    try {
      const statement = parseBoaStatement(text);
      if (statement.mismatches.length > 0) return { reason: REASONS.mismatch };
      return { parsed: parseStatementAtPath(file.path, toCsv(statement.transactions)) };
    } catch (err) {
      if (err instanceof UnrecognizedStatement) return { reason: REASONS.unrecognized };
      return { reason: REASONS.unreadable };
    }
  }
  try {
    const parsed = parseStatementAtPath(file.path, read.bytes.toString("utf8"));
    return parsed.rows.length ? { parsed } : { reason: REASONS.empty, parsed };
  } catch {
    return { reason: REASONS.unreadable };
  }
}

/* ------------------------------------------------------------------- run */

async function statementsDirFrom(env, home) {
  const raw = await readCapped(join(stateDirFor(env, home), "state.json"), MAX_STATE_BYTES);
  if (!raw) return "";
  const dir = parseStateFile(raw.toString("utf8"))?.statementsDir ?? "";
  // A relative path would be read against wherever this happens to run.
  return isAbsolute(dir) ? dir : "";
}

function defaultNotify(text) {
  // Counts only: this text is on notify-send's command line.
  spawnSync("notify-send", ["-a", "Omakei", "Omakei", text], { stdio: "ignore", timeout: 5000 });
}

function parseArgs(argv) {
  const opts = { notify: false, status: false, json: false, rescan: false, settleMs: SETTLE_MS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--notify") opts.notify = true;
    else if (a === "--status") opts.status = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--rescan") opts.rescan = true;
    else if (a === "--settle" && /^\d+$/.test(argv[i + 1] ?? ""))
      opts.settleMs = Number(argv[++i]) * 1000;
    else return null;
  }
  return opts;
}

export async function run(
  argv,
  {
    env = process.env,
    home = homedir(),
    now = Date.now(),
    out = process.stdout,
    err = process.stderr,
    notify = defaultNotify,
  } = {},
) {
  process.umask(0o077);
  const opts = parseArgs(argv);
  if (!opts) {
    err.write(
      "Usage: omakei-import.mjs [--notify] [--rescan] [--json] [--settle <seconds>] | --status\n",
    );
    return 2;
  }
  const root = await statementsDirFrom(env, home);
  if (!root) {
    err.write("No statements folder attached. Attach one in the editor first.\n");
    return 1;
  }
  const stateDir = stateDirFor(env, home);
  const ledgerDir = await prepareLedgerDir(root, { env, home });

  if (opts.status) {
    const records = (await readLedgerDb(ledgerDir))?.ledger?.importedFiles ?? [];
    if (opts.json) out.write(`${JSON.stringify(records)}\n`);
    else if (records.length === 0) out.write("No files imported yet.\n");
    else {
      for (const r of records) {
        const d = new Date(r.importedAt);
        const pad = (n) => String(n).padStart(2, "0");
        const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const what =
          r.status === "failed" ? `failed: ${r.reason}` : `${r.status}, ${r.added} added`;
        out.write(`${when}  ${printable(r.path)}  (${what})\n`);
      }
    }
    return 0;
  }

  const release = takeLock(stateDir, now);
  if (!release) {
    out.write("Another import is running; nothing to do.\n");
    return 0;
  }
  try {
    const plan = planFiles(scanFolder(root), now, opts.settleMs);
    const waiting = plan.waiting.map((f) => ({
      path: f.path,
      why: "changed in the last few minutes",
    }));
    const current = await readLedgerDb(ledgerDir);
    const seen = opts.rescan ? new Set() : seenHashes(current?.ledger?.importedFiles);
    const files = [];
    for (const file of plan.ready) {
      const read = readStable(root, file);
      if (read.skip) {
        waiting.push({ path: file.path, why: read.skip });
        continue;
      }
      try {
        const sha256 = createHash("sha256").update(read.bytes).digest("hex");
        if (seen.has(sha256)) {
          files.push({ path: file.path, sha256, size: read.bytes.length, parsed: null });
          continue;
        }
        const outcome = parseFile(file, read);
        if (outcome.skip) {
          waiting.push({ path: file.path, why: outcome.skip });
          continue;
        }
        files.push({
          path: file.path,
          sha256,
          size: read.bytes.length,
          parsed: outcome.parsed ?? null,
          reason: outcome.reason,
        });
      } finally {
        closeSync(read.fd);
      }
    }

    let summary;
    const result = await updateLedgerDb(ledgerDir, ({ ledger }) => {
      const decided = applyImport(ledger, files, now, { rescan: opts.rescan });
      summary = decided.summary;
      return decided.next;
    });
    if (!result) {
      err.write("The ledger cannot be opened safely; nothing was imported.\n");
      return 1;
    }
    if (result.written) await bumpRevisionAt(stateDir);

    const notice = noticeText(summary);
    if (opts.json) {
      out.write(
        `${JSON.stringify({ ...summary, waiting, shadowed: plan.shadowed.map((f) => f.path) })}\n`,
      );
    } else {
      out.write(`${notice ?? "Nothing new."}\n`);
      if (summary.imported.length) out.write(`From ${summary.imported.length} file(s).\n`);
      for (const f of summary.failed)
        out.write(`  could not read ${printable(f.path)}: ${f.reason}\n`);
      for (const w of waiting) out.write(`  left for next time ${printable(w.path)}: ${w.why}\n`);
      if (summary.alreadySeen.length)
        out.write(`${summary.alreadySeen.length} file(s) already imported.\n`);
    }
    if (opts.notify && notice) notify(notice);
    return 0;
  } finally {
    release();
  }
}

if (process.argv[1]?.endsWith("omakei-import.mjs")) {
  // A closed pipe (`| head`) is not a reason to die holding the lock.
  process.stdout.on("error", () => {});
  process.stderr.on("error", () => {});
  run(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`omakei-import: ${error?.message ?? error}\n`);
      process.exitCode = 1;
    });
}
