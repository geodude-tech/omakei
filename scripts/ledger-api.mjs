/**
 * The one place Omakei touches disk.
 *
 * The editor is a browser page with no filesystem of its own, so the server
 * owns the attached folder: it remembers which folder that is, lists and reads
 * the statements in it, and writes `omakei-ledger.json` back into it. Both the
 * Vite dev server and `omakei-serve.mjs` mount this same handler, so what you
 * see in development is what an installer runs.
 *
 * Because the server knows the real path, it also records it in the state file
 * that `Panel.qml` reads — which is why nobody has to type a ledger path into
 * widget settings.
 *
 * No npm dependencies: `omarchy plugin add` clones the git tree and never runs
 * `npm install`.
 */
import { constants as FS } from "node:fs";
import { mkdir, open, readdir, rename, stat, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

export const API_PREFIX = "/__omakei";
export const LEDGER_FILENAME = "omakei-ledger.json";
/** Rewritten whenever the ledger changes, so the bar widget knows to re-read. */
export const REVISION_FILENAME = "ledger-revision";

export const MAX_LEDGER_BYTES = 20 * 1024 * 1024;
const MAX_STATEMENT_BYTES = 32 * 1024 * 1024;
/** The state file holds one small JSON object; anything larger is not ours. */
export const MAX_STATE_BYTES = 64 * 1024;

export const STATEMENT_EXTS = new Set([".csv", ".tsv", ".ofx", ".qfx", ".ofc", ".txt"]);

/* ------------------------------------------------------------------ paths */

export function stateDirFor(env = process.env, home = homedir()) {
  return join(env.XDG_STATE_HOME || join(home, ".local/state"), "omakei");
}

export function expandHome(path, home) {
  const p = String(path || "").trim();
  const root = String(home || "");
  if (p === "~") return root;
  if (p.startsWith("~/")) return join(root, p.slice(2));
  return p;
}

/** Resolve `rel` under `root`, refusing anything that escapes it. */
export function safeJoin(root, rel) {
  const abs = resolve(root, rel);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (abs !== root && !abs.startsWith(prefix)) return null;
  if (relative(root, abs).split(sep).includes("..")) return null;
  return abs;
}

/* ----------------------------------------------------------------- guards */

export function isLoopbackSocket(req) {
  const addr = req.socket?.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

/** Host header must name loopback, so a rebound DNS name cannot reach us. */
export function isLoopbackHost(hostHeader) {
  const host = String(hostHeader || "").trim().toLowerCase();
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

/**
 * A page on another origin can still make the browser send a request here.
 * Requests that carry a foreign Origin are refused, which keeps the ledger
 * out of reach of whatever else the user has open.
 */
export function isAllowedOrigin(originHeader) {
  const origin = String(originHeader || "").trim();
  if (!origin || origin === "null") return true;
  try {
    const url = new URL(origin);
    return isLoopbackHost(url.host);
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ state */

export function isLedgerPayload(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      value.version === 1 &&
      Array.isArray(value.transactions) &&
      Array.isArray(value.rules),
  );
}

/** The widget reads this file, so its shape is part of the plugin contract. */
export function renderStateFile(statementsDir) {
  return `${JSON.stringify({
    version: 1,
    statementsDir: statementsDir || "",
    ledgerPath: statementsDir ? join(statementsDir, LEDGER_FILENAME) : "",
  })}\n`;
}

export function parseStateFile(text) {
  try {
    const data = JSON.parse(String(text || ""));
    if (!data || data.version !== 1) return null;
    const dir = typeof data.statementsDir === "string" ? data.statementsDir : "";
    return dir ? { statementsDir: dir } : null;
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------------- helpers */

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body), "utf8");
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("content-length", String(buf.byteLength));
  res.end(buf);
}

function deny(res, status, message) {
  json(res, status, { error: message });
}

function readBody(req, limit) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        const err = new Error("too large");
        err.code = "LIMIT";
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/* ------------------------------------------------------------------- disk */

/**
 * Read a regular file, bounded, without ever following a symlink at the final
 * path component.
 *
 * Everything Omakei reads sits in a directory the user chose, and the paths are
 * predictable: `omakei-ledger.json`, `state.json`, the statements themselves.
 * Checking a path and then re-opening it by that path leaves a window where
 * what was checked and what is read are different files, so the check happens
 * on the descriptor and the read comes from the same descriptor.
 *
 * - `O_NOFOLLOW` refuses a symlink in place of the file.
 * - `O_NONBLOCK` keeps a FIFO left in the folder from hanging the open, which
 *   would otherwise stall the server before the regular-file check can run.
 * - `fstat` on the open descriptor decides the type and size.
 * - At most `max` bytes are read, so a file that grows after the stat cannot
 *   grow past the cap either.
 *
 * Returns null for anything that is not a readable regular file within `max`.
 *
 * The no-follow guarantee covers the last component only. A symlinked *parent*
 * directory still resolves, which Node cannot prevent without `openat2`.
 */
export async function readCapped(path, max) {
  let fh;
  try {
    fh = await open(path, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
    const info = await fh.stat();
    if (!info.isFile()) return null;
    if (info.size > max) return null;
    const buf = Buffer.alloc(Math.min(info.size, max));
    let read = 0;
    while (read < buf.length) {
      const { bytesRead } = await fh.read(buf, read, buf.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
    }
    return buf.subarray(0, read);
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * Replace a file atomically, through a temp file nobody can predict or preempt.
 *
 * The temp name used to be `<path>.tmp`, which is guessable: anything that got
 * there first with a symlink would have had this write follow it out of the
 * folder. Now the name carries random bytes and is created with `O_EXCL`, so an
 * existing file at that path — symlink or not — fails the open instead of being
 * written through. It is created in the destination's own directory because
 * `rename` is only atomic within one filesystem.
 *
 * The data is flushed before the rename, so the file the rename publishes is
 * the whole file rather than whatever reached disk first.
 */
export async function writeAtomic(path, text) {
  const dir = dirname(path);
  const tmp = join(dir, `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  let fh;
  try {
    fh = await open(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
    await fh.writeFile(text, "utf8");
    await fh.sync();
    await fh.close();
    fh = undefined;
    await rename(tmp, path);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/**
 * Touch the file the bar widget watches.
 *
 * The widget cannot watch the ledger: doing that safely means bounding what it
 * reads, and QML has no way to bound a read. So it watches this instead and
 * never reads it -- the token is only here to make the file change. The write
 * is in place rather than through a rename because nothing depends on it being
 * atomic, and O_NOFOLLOW keeps it consistent with every other write this module
 * makes.
 *
 * A failure here costs a live refresh, not a save, so it is swallowed: the
 * widget still re-reads when the panel is opened. Callers that write the ledger
 * outside the server (`omakei-categorize.mjs`) call this so the bar still
 * updates.
 */
export async function bumpRevisionAt(stateDir) {
  let fh;
  try {
    await mkdir(stateDir, { recursive: true });
    fh = await open(
      join(stateDir, REVISION_FILENAME),
      FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC | FS.O_NOFOLLOW,
      0o600,
    );
    await fh.writeFile(`${Date.now()}\n`, "utf8");
  } catch {
    /* nothing the user can do about it, and nothing that should fail a save */
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Statement files at or just below `dir`, so the picker can say which folder
 * actually holds exports. Bounded on purpose: a listing must never stall on a
 * home directory full of source trees, so the walk stops at `depth` levels and
 * shares a directory budget across one request.
 */
async function countStatements(dir, depth, budget) {
  if (depth < 0 || budget.left <= 0) return 0;
  budget.left -= 1;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let n = 0;
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.isFile()) {
      if (STATEMENT_EXTS.has(extname(entry.name).toLowerCase())) n += 1;
    } else if (entry.isDirectory() && depth > 0) {
      n += await countStatements(join(dir, entry.name), depth - 1, budget);
    }
  }
  return n;
}

/**
 * The handful of folders worth one click, skipping any this machine lacks.
 *
 * Mounted volumes are in here because the picker has no path box on purpose:
 * statements kept on an external drive have to be reachable by clicking, and
 * climbing to `/` and back down is not that.
 */
async function placesFor(home) {
  const found = [];
  for (const place of [
    { name: "Home", path: home },
    { name: "Documents", path: join(home, "Documents") },
    { name: "Downloads", path: join(home, "Downloads") },
    { name: "Desktop", path: join(home, "Desktop") },
  ]) {
    if (await isDirectory(place.path)) found.push(place);
  }
  for (const root of [join("/run/media", basename(home)), join("/media", basename(home)), "/mnt"]) {
    let mounted;
    try {
      mounted = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of mounted) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) {
        found.push({ name: entry.name, path: join(root, entry.name) });
      }
    }
  }
  return found;
}

async function listStatements(root) {
  const out = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!STATEMENT_EXTS.has(extname(entry.name).toLowerCase())) continue;
      out.push({ path: relative(root, full).split(sep).join("/"), name: entry.name });
    }
  }
  await walk(root);
  // Plain codepoint order: locale-dependent sorting would list the same
  // folder differently on different machines.
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/* -------------------------------------------------------------- the handler */

/**
 * Returns `handle(req, res) -> Promise<boolean>`; false means the request was
 * not ours and the caller should fall through to static files.
 */
export function createLedgerApi({ env = process.env, home = homedir() } = {}) {
  const stateDir = stateDirFor(env, home);
  const statePath = join(stateDir, "state.json");
  const revisionPath = join(stateDir, REVISION_FILENAME);
  const seedDir = String(env.OMAKEI_STATEMENTS_DIR || "").trim();

  let cached;

  async function currentDir() {
    if (cached === undefined) {
      const raw = await readCapped(statePath, MAX_STATE_BYTES);
      const saved = parseStateFile(raw ? raw.toString("utf8") : "");
      // The env var is a convenience default for development. It seeds the
      // same state every other install writes, so no code path is dev-only.
      cached = saved?.statementsDir || (seedDir ? resolve(expandHome(seedDir, home)) : null);
      if (!saved && cached) await persist(cached);
    }
    return cached;
  }

  async function persist(dir) {
    cached = dir;
    await mkdir(stateDir, { recursive: true });
    await writeAtomic(statePath, renderStateFile(dir));
    // Attaching or detaching changes which ledger is the current one, which is
    // as much a change to the widget as editing the ledger itself.
    await bumpRevision();
  }

  const bumpRevision = () => bumpRevisionAt(stateDir);

  async function readLedger(dir) {
    // A ledger larger than the cap is refused on the way in as well as on the
    // way out: this runs on every /state call, into a long-lived server.
    const raw = await readCapped(join(dir, LEDGER_FILENAME), MAX_LEDGER_BYTES);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw.toString("utf8"));
      return isLedgerPayload(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  /** One round-trip with everything the editor needs to paint. */
  async function stateBody() {
    const dir = await currentDir();
    if (!dir || !(await isDirectory(dir))) {
      return { folder: null, ledger: null, ledgerPath: "", home };
    }
    return {
      folder: { path: dir, name: basename(dir) },
      ledger: await readLedger(dir),
      ledgerPath: join(dir, LEDGER_FILENAME),
      home,
    };
  }

  async function handle(req, res) {
    const [pathOnly = "", query = ""] = (req.url ?? "").split("?", 2);
    if (pathOnly !== API_PREFIX && !pathOnly.startsWith(`${API_PREFIX}/`)) return false;

    if (!isLoopbackSocket(req) || !isLoopbackHost(req.headers?.host)) {
      deny(res, 403, "Omakei is reachable from this machine only");
      return true;
    }
    if (!isAllowedOrigin(req.headers?.origin)) {
      deny(res, 403, "Cross-origin requests are refused");
      return true;
    }

    const method = (req.method ?? "GET").toUpperCase();
    const route = pathOnly.slice(API_PREFIX.length) || "/";

    try {
      if (route === "/state" && method === "GET") {
        json(res, 200, await stateBody());
        return true;
      }

      if (route === "/folder") {
        if (method === "POST") {
          const raw = await readBody(req, 64 * 1024);
          let body;
          try {
            body = JSON.parse(raw.toString("utf8"));
          } catch {
            deny(res, 400, "Invalid JSON");
            return true;
          }
          const wanted = resolve(expandHome(body?.path, home));
          if (!wanted || !(await isDirectory(wanted))) {
            deny(res, 400, "That is not a folder on this machine");
            return true;
          }
          await persist(wanted);
          json(res, 200, await stateBody());
          return true;
        }
        if (method === "DELETE") {
          await persist(null);
          json(res, 200, await stateBody());
          return true;
        }
        deny(res, 405, "Method Not Allowed");
        return true;
      }

      // Lets the editor offer a real folder picker: the path it returns is one
      // the widget can open directly, which a browser file picker never gives.
      if (route === "/browse" && method === "GET") {
        const asked = new URLSearchParams(query).get("path") ?? "";
        const dir = resolve(expandHome(asked || home, home));
        if (!(await isDirectory(dir))) {
          deny(res, 404, "No such folder");
          return true;
        }
        let dirents;
        try {
          dirents = await readdir(dir, { withFileTypes: true });
        } catch {
          // A folder you cannot read is a dead end, not a server fault. The
          // picker has no path box, so it says so and leaves you where you were.
          deny(res, 403, "Could not read that folder");
          return true;
        }
        const names = [];
        for (const entry of dirents) {
          if (entry.name.startsWith(".")) continue;
          const path = join(dir, entry.name);
          // A symlinked folder is followed on purpose: `~/Statements` pointing
          // at an external drive is a normal way to keep them, and with no path
          // box to type into, hiding the link would put that folder out of
          // reach entirely. A broken link stats false and is skipped.
          if (!entry.isDirectory() && !(entry.isSymbolicLink() && (await isDirectory(path)))) {
            continue;
          }
          names.push({ name: entry.name, path });
        }
        names.sort((a, b) => a.name.localeCompare(b.name));
        // Each row is counted one level deep and the folder you are standing in
        // two, so "which of these has my exports?" is answered without walking
        // the tree. Statements commonly sit in a `Credit/` or `Checking/`
        // subfolder, which is why a row looks past its own files. Every row
        // gets its own budget: a shared one would let a source tree earlier in
        // the list starve the real statements folder into reading as empty.
        const entries = [];
        for (const entry of names) {
          entries.push({
            ...entry,
            statements: await countStatements(entry.path, 1, { left: 64 }),
          });
        }
        const parent = dirname(dir);
        json(res, 200, {
          path: dir,
          parent: parent === dir ? null : parent,
          entries,
          statements: await countStatements(dir, 2, { left: 256 }),
          home,
          places: await placesFor(home),
        });
        return true;
      }

      if (route === "/statements" && method === "GET") {
        const dir = await currentDir();
        if (!dir || !(await isDirectory(dir))) {
          json(res, 200, { files: [] });
          return true;
        }
        json(res, 200, { files: await listStatements(dir) });
        return true;
      }

      if (route === "/statements/file" && method === "GET") {
        const dir = await currentDir();
        if (!dir) {
          deny(res, 409, "No folder is attached");
          return true;
        }
        const rel = new URLSearchParams(query).get("path") ?? "";
        if (!rel || rel.includes("\0")) {
          deny(res, 400, "Missing path");
          return true;
        }
        const abs = safeJoin(dir, rel);
        if (!abs || !STATEMENT_EXTS.has(extname(abs).toLowerCase())) {
          deny(res, 400, "Not a statement file in the attached folder");
          return true;
        }
        // One open decides the type, the size, and the bytes. Statements are
        // listed with readdir's own type info, which already skips symlinks, so
        // refusing to follow one here changes nothing a user could reach.
        const raw = await readCapped(abs, MAX_STATEMENT_BYTES);
        if (!raw) {
          const info = await stat(abs).catch(() => null);
          if (info?.isFile() && info.size > MAX_STATEMENT_BYTES) {
            deny(res, 413, "That statement file is too large to read");
            return true;
          }
          deny(res, 404, "No such file");
          return true;
        }
        json(res, 200, { path: rel, text: raw.toString("utf8") });
        return true;
      }

      if (route === "/ledger" && method === "PUT") {
        const dir = await currentDir();
        if (!dir || !(await isDirectory(dir))) {
          deny(res, 409, "No folder is attached");
          return true;
        }
        let raw;
        try {
          raw = await readBody(req, MAX_LEDGER_BYTES);
        } catch (err) {
          if (err?.code === "LIMIT") {
            deny(res, 413, "Ledger is too large");
            return true;
          }
          throw err;
        }
        let parsed;
        try {
          parsed = JSON.parse(raw.toString("utf8"));
        } catch {
          deny(res, 400, "Invalid JSON");
          return true;
        }
        if (!isLedgerPayload(parsed)) {
          deny(res, 400, "Invalid ledger");
          return true;
        }
        await writeAtomic(join(dir, LEDGER_FILENAME), `${JSON.stringify(parsed)}\n`);
        await bumpRevision();
        json(res, 200, { ok: true });
        return true;
      }

      deny(res, 404, "Not found");
      return true;
    } catch (err) {
      console.error("[omakei] api failed:", err?.message || err);
      if (!res.headersSent) deny(res, 500, "Omakei could not complete that");
      else res.end();
      return true;
    }
  }

  return { handle, statePath, revisionPath, stateBody };
}
