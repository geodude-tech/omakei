#!/usr/bin/env node
/**
 * Serves the built ledger editor. No npm dependencies on purpose: `omarchy
 * plugin add` clones the git tree and never runs `npm install`, so this has to
 * run on a stock Node.
 *
 * Static files come straight from `dist/`. `index.html` is filled in per
 * request with the user's current Omarchy theme, which is why the committed
 * bundle carries no theme of its own.
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderShell } from "./page-shell.mjs";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DIST = resolve(process.env.OMAKEI_DIST || join(ROOT, "dist"));
const HOST = process.env.OMAKEI_HOST || "127.0.0.1";
const PORT = Number(process.env.OMAKEI_PORT || 8080);

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** Resolve a URL path inside DIST, refusing anything that escapes it. */
function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const candidate = resolve(join(DIST, normalize(decoded)));
  if (candidate !== DIST && !candidate.startsWith(DIST + "/")) return null;
  return candidate;
}

async function sendIndex(res, status = 200) {
  const raw = await readFile(join(DIST, "index.html"), "utf8");
  const body = Buffer.from(renderShell(raw), "utf8");
  res.writeHead(status, {
    "content-type": MIME[".html"],
    "content-length": body.byteLength,
    // The shell is theme-dependent and the ledger is private.
    "cache-control": "no-store",
  });
  res.end(body);
}

const server = createServer(async (req, res) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD" }).end();
      return;
    }
    const target = safePath(req.url || "/");
    if (!target) {
      res.writeHead(403).end();
      return;
    }
    let info = null;
    try {
      info = await stat(target);
    } catch {
      /* falls through to the SPA shell */
    }
    if (!info || info.isDirectory()) {
      await sendIndex(res, info ? 200 : 200);
      return;
    }
    const ext = extname(target).toLowerCase();
    if (ext === ".html") {
      await sendIndex(res);
      return;
    }
    const body = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "content-length": body.byteLength,
      // Hashed asset names, so this is safe and keeps reopens instant.
      "cache-control": "public, max-age=31536000, immutable",
    });
    res.end(req.method === "HEAD" ? undefined : body);
  } catch (err) {
    console.error("[omakei] request failed:", err?.message || err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("omakei failed to serve that");
  }
});

try {
  await stat(join(DIST, "index.html"));
} catch {
  console.error(`[omakei] no build at ${DIST}\n         run: npm install && npm run build`);
  process.exit(1);
}

server.listen(PORT, HOST, () => {
  console.log(`Omakei on http://${HOST}:${PORT}/`);
});
