/**
 * Dev-only local statement loader.
 * Reads FOLIO_STATEMENTS_DIR from the environment (typically `.env.local`)
 * and serves file list/contents only to localhost. Real statements stay on disk.
 */
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import { readFileSync } from "node:fs";

export const LOCAL_STATEMENTS_ROUTE = "/__folio/local-statements";
export const LOCAL_LEDGER_ROUTE = `${LOCAL_STATEMENTS_ROUTE}/ledger`;
export const LEDGER_FILENAME = "omakei-ledger.json";
export const LEGACY_LEDGER_FILENAME = "folio-ledger.json";
const MAX_LEDGER_BYTES = 20 * 1024 * 1024;

const ALLOWED_EXT = new Set([".csv", ".tsv", ".ofx", ".qfx", ".ofc", ".txt"]);

export function isLocalhost(req) {
  const addr = req.socket?.remoteAddress ?? "";
  return addr === "127.0.0.1" || addr === "::1" || addr === "::ffff:127.0.0.1";
}

export function readEnvValue(text, key) {
  if (!text) return "";
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const name = trimmed
      .slice(0, eq)
      .trim()
      .replace(/^export\s+/, "");
    if (name !== key) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return "";
}

export function expandHome(path, home) {
  const p = String(path || "").trim();
  const root = String(home || "");
  if (p === "~") return root;
  if (p.startsWith("~/")) return root + "/" + p.slice(2);
  return p;
}

export function resolveStatementsDir({ processEnv = {}, envFileText = "", home = "" } = {}) {
  const raw = (
    String(processEnv.FOLIO_STATEMENTS_DIR || "").trim() ||
    readEnvValue(envFileText, "FOLIO_STATEMENTS_DIR")
  ).trim();
  if (!raw) return null;
  return resolve(expandHome(raw, home));
}

function readFileIfExists(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function statementsDir(root) {
  return resolveStatementsDir({
    processEnv: process.env,
    envFileText: [".env.local", ".env"]
      .map((name) => readFileIfExists(join(root, name)))
      .filter(Boolean)
      .join("\n"),
    home: homedir(),
  });
}

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

function safeJoin(root, rel) {
  const abs = resolve(root, rel);
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (abs !== root && !abs.startsWith(prefix)) return null;
  if (relative(root, abs).split(sep).includes("..")) return null;
  return abs;
}

export function isLedgerPayload(value) {
  return Boolean(
    value &&
    typeof value === "object" &&
    value.version === 1 &&
    Array.isArray(value.transactions) &&
    Array.isArray(value.rules) &&
    value.isSample !== true,
  );
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

async function listFiles(root) {
  const out = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!ALLOWED_EXT.has(extname(entry.name).toLowerCase())) continue;
      out.push({
        path: relative(root, full).split(sep).join("/"),
        name: entry.name,
      });
    }
  }
  await walk(root);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

async function ensureStatementsRoot(root, res, allowUnconfigured = true) {
  if (!root) {
    if (allowUnconfigured) {
      json(res, 200, { configured: false, files: [], folderName: null, ledger: null });
    } else {
      deny(res, 404, "FOLIO_STATEMENTS_DIR is not configured");
    }
    return null;
  }
  try {
    const info = await stat(root);
    if (!info.isDirectory()) {
      deny(res, 500, "FOLIO_STATEMENTS_DIR is not a directory");
      return null;
    }
  } catch {
    deny(res, 404, "FOLIO_STATEMENTS_DIR does not exist");
    return null;
  }
  return root;
}

export function localStatementsPlugin() {
  return {
    name: "folio:local-statements",
    apply: "serve",
    configureServer(server) {
      const projectRoot = server.config.root;
      server.middlewares.use(async (req, res, next) => {
        const rawUrl = req.url ?? "";
        const [pathOnly, query = ""] = rawUrl.split("?", 2);
        if (!pathOnly?.startsWith(LOCAL_STATEMENTS_ROUTE)) {
          next();
          return;
        }
        if (!isLocalhost(req)) {
          deny(res, 403, "Local statements are only available on localhost");
          return;
        }
        const method = (req.method ?? "GET").toUpperCase();
        const root = statementsDir(projectRoot);

        try {
          if (pathOnly === LOCAL_LEDGER_ROUTE) {
            if (method === "GET") {
              const dir = await ensureStatementsRoot(root, res);
              if (!dir) return;
              let ledger = null;
              for (const name of [LEDGER_FILENAME, LEGACY_LEDGER_FILENAME]) {
                try {
                  const text = await readFile(join(dir, name), "utf8");
                  const parsed = JSON.parse(text);
                  if (isLedgerPayload(parsed)) {
                    ledger = parsed;
                    break;
                  }
                } catch (err) {
                  if (err && err.code !== "ENOENT" && !(err instanceof SyntaxError)) throw err;
                }
              }
              json(res, 200, {
                configured: true,
                folderName: basename(dir),
                ledger,
              });
              return;
            }
            if (method === "PUT") {
              const dir = await ensureStatementsRoot(root, res, false);
              if (!dir) return;
              let raw;
              try {
                raw = await readBody(req, MAX_LEDGER_BYTES);
              } catch (err) {
                if (err && err.code === "LIMIT") {
                  deny(res, 413, "Ledger is too large");
                  return;
                }
                throw err;
              }
              let parsed;
              try {
                parsed = JSON.parse(raw.toString("utf8"));
              } catch {
                deny(res, 400, "Invalid JSON");
                return;
              }
              if (!isLedgerPayload(parsed)) {
                deny(res, 400, "Invalid ledger");
                return;
              }
              const ledgerPath = join(dir, LEDGER_FILENAME);
              const tmpPath = `${ledgerPath}.tmp`;
              const text = `${JSON.stringify(parsed)}\n`;
              await writeFile(tmpPath, text, "utf8");
              await rename(tmpPath, ledgerPath);
              json(res, 200, { ok: true, folderName: basename(dir) });
              return;
            }
            deny(res, 405, "Method Not Allowed");
            return;
          }

          if (method !== "GET") {
            deny(res, 405, "Method Not Allowed");
            return;
          }

          const dir = await ensureStatementsRoot(root, res);
          if (!dir) return;

          if (pathOnly === LOCAL_STATEMENTS_ROUTE) {
            json(res, 200, {
              configured: true,
              folderName: basename(dir),
              files: await listFiles(dir),
            });
            return;
          }
          if (pathOnly === `${LOCAL_STATEMENTS_ROUTE}/file`) {
            const rel = new URLSearchParams(query).get("path") ?? "";
            if (!rel || rel.includes("\0")) {
              deny(res, 400, "Missing path");
              return;
            }
            const abs = safeJoin(dir, rel);
            if (!abs) {
              deny(res, 400, "Invalid path");
              return;
            }
            if (!ALLOWED_EXT.has(extname(abs).toLowerCase())) {
              deny(res, 400, "Unsupported file type");
              return;
            }
            const text = await readFile(abs, "utf8");
            const body = Buffer.from(
              JSON.stringify({ path: rel, name: rel.split("/").pop(), text }),
              "utf8",
            );
            res.statusCode = 200;
            res.setHeader("content-type", "application/json; charset=utf-8");
            res.setHeader("cache-control", "no-store");
            res.setHeader("content-length", String(body.byteLength));
            res.end(body);
            return;
          }
          deny(res, 404, "Not found");
        } catch (err) {
          console.error("[folio] local statements failed:", err);
          deny(res, 500, "Failed to read local statements");
        }
      });
    },
  };
}
