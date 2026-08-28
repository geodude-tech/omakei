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
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";

export const API_PREFIX = "/__omakei";
export const LEDGER_FILENAME = "omakei-ledger.json";

const MAX_LEDGER_BYTES = 20 * 1024 * 1024;
const MAX_STATEMENT_BYTES = 32 * 1024 * 1024;

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

/** Write through a temp file so a crash mid-write cannot truncate the ledger. */
async function writeAtomic(path, text) {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, path);
}

async function isDirectory(path) {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
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
  const seedDir = String(env.OMAKEI_STATEMENTS_DIR || "").trim();

  let cached;

  async function currentDir() {
    if (cached === undefined) {
      const saved = parseStateFile(await readFile(statePath, "utf8").catch(() => ""));
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
  }

  async function readLedger(dir) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, LEDGER_FILENAME), "utf8"));
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
        const entries = (await readdir(dir, { withFileTypes: true }))
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .map((e) => ({ name: e.name, path: join(dir, e.name) }))
          .sort((a, b) => a.name.localeCompare(b.name));
        const parent = dirname(dir);
        json(res, 200, { path: dir, parent: parent === dir ? null : parent, entries });
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
        const info = await stat(abs).catch(() => null);
        if (!info?.isFile()) {
          deny(res, 404, "No such file");
          return true;
        }
        if (info.size > MAX_STATEMENT_BYTES) {
          deny(res, 413, "That statement file is too large to read");
          return true;
        }
        json(res, 200, { path: rel, text: await readFile(abs, "utf8") });
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

  return { handle, statePath, stateBody };
}
