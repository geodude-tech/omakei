/**
 * The one place Omakei touches disk.
 *
 * The editor is a browser page with no filesystem of its own, so the server
 * owns the attached folder: it remembers which folder that is, lists and reads
 * the statements in it, and keeps that folder's ledger in
 * `omakei-ledger.sqlite` under a private directory of the state dir (see
 * `ledgerDirFor` and `ledger-db.mjs`). Both the
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
import { link, lstat, mkdir, open, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { LedgerShapeError, readLedgerDb, updateLedgerDb } from "./ledger-db.mjs";

export const API_PREFIX = "/__omakei";
/** The ledger. */
export const DB_FILENAME = "omakei-ledger.sqlite";
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

/**
 * Where the ledger for `statementsDir` lives: a directory of its own under
 * `<state>/ledgers/`, created mode 0700.
 *
 * The ledger used to sit in the attached folder. That folder is the user's to
 * choose -- a synced or mounted directory, possibly writable by something
 * else -- and SQLite opens by pathname, follows symlinks, and has no
 * `SQLITE_OPEN_NOFOLLOW` in `node:sqlite`. Nothing can check a name in a folder
 * someone else can rename into and then have SQLite open that same file. A
 * directory only this user can write has no one to race, so the writable
 * database and its journal live there, and `ledger-db.mjs` refuses to write
 * anywhere that is not private like this.
 *
 * Keyed by the folder's path, so attaching a different folder still means a
 * different ledger, as it did when the ledger sat inside it.
 */
export function ledgerDirFor(statementsDir, env = process.env, home = homedir()) {
  const key = createHash("sha256").update(resolve(String(statementsDir))).digest("hex").slice(0, 16);
  return join(stateDirFor(env, home), LEDGERS_DIRNAME, key);
}

export const LEDGERS_DIRNAME = "ledgers";

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

/**
 * `/proc/net/tcp{,6}` address, as `127.0.0.1` or `::1`, or null for anything
 * else. IPv4 is one little-endian word; a v4-mapped IPv6 address reads as the
 * IPv4 it carries, because a dual-stack server sees `::ffff:127.0.0.1` for a
 * client whose own socket is plain IPv4.
 */
function procAddress(hex) {
  const v4 = (h) =>
    [h.slice(6, 8), h.slice(4, 6), h.slice(2, 4), h.slice(0, 2)].map((b) => parseInt(b, 16)).join(".");
  const h = String(hex).toUpperCase();
  if (/^[0-9A-F]{8}$/.test(h)) return v4(h);
  if (h === "00000000000000000000000001000000") return "::1";
  if (/^0000000000000000FFFF0000[0-9A-F]{8}$/.test(h)) return v4(h.slice(24));
  return null;
}

function plainAddress(addr) {
  const a = String(addr || "");
  return a.toLowerCase().startsWith("::ffff:") ? a.slice(7) : a;
}

/**
 * The uid that owns the client end of a loopback connection, read from the
 * kernel's socket tables (`/proc/net/tcp` and `/proc/net/tcp6` text), or null
 * when no such socket is listed.
 *
 * The client's socket is the one whose local end is the peer's address and
 * port and whose remote end is ours. The server's own accepted socket is the
 * mirror image and always carries the server's uid, so both ends are matched.
 */
export function socketOwnerFrom(tables, { localAddress, localPort, remoteAddress, remotePort }) {
  const client = plainAddress(remoteAddress);
  const server = plainAddress(localAddress);
  for (const table of tables) {
    for (const line of String(table || "").split("\n")) {
      const f = line.trim().split(/\s+/);
      if (f.length < 8 || !/^\d+:$/.test(f[0])) continue;
      const [la, lp] = f[1].split(":");
      const [ra, rp] = f[2].split(":");
      if (parseInt(lp, 16) !== remotePort || parseInt(rp, 16) !== localPort) continue;
      if (procAddress(la) !== client || procAddress(ra) !== server) continue;
      const uid = Number(f[7]);
      return Number.isInteger(uid) ? uid : null;
    }
  }
  return null;
}

const peerChecks = new WeakMap();

/**
 * True when the process on the other end of this loopback connection runs as
 * `uid` -- by default, the user running this server.
 *
 * Loopback is not the same as "this user". Any account on the machine can
 * connect to 127.0.0.1, and the Host and Origin guards only say what a browser
 * claims, not who is asking. The ledger and the statements are read with the
 * server owner's permissions, so the connection has to belong to that owner.
 * The kernel already records who opened each socket; asking it costs the
 * browser and the widget nothing, needs no token to leak, and cannot be forged
 * from another account.
 *
 * Linux only, like the `/proc/self/fd` anchoring below. Fails closed: if the
 * owner cannot be found, the request is refused. Answered once per connection.
 */
export function isSameUserPeer(req, uid = process.getuid?.()) {
  const socket = req.socket;
  if (!socket || typeof uid !== "number") return Promise.resolve(false);
  let checks = peerChecks.get(socket);
  if (!checks) {
    checks = new Map();
    peerChecks.set(socket, checks);
  }
  let answer = checks.get(uid);
  if (!answer) {
    const ends = {
      localAddress: socket.localAddress,
      localPort: socket.localPort,
      remoteAddress: socket.remoteAddress,
      remotePort: socket.remotePort,
    };
    answer = Promise.all(
      ["/proc/net/tcp", "/proc/net/tcp6"].map((p) => readFile(p, "utf8").catch(() => "")),
    ).then(
      (tables) => socketOwnerFrom(tables, ends) === uid,
      () => false,
    );
    checks.set(uid, answer);
  }
  return answer;
}

/** Host header must name loopback, so a rebound DNS name cannot reach us. */
export function isLoopbackHost(hostHeader) {
  const host = String(hostHeader || "").trim().toLowerCase();
  if (!host) return false;
  const name = host.startsWith("[") ? host.slice(1, host.indexOf("]")) : host.split(":")[0];
  return name === "127.0.0.1" || name === "localhost" || name === "::1";
}

/** Methods that change something on disk, and so answer to the stricter rule. */
const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * A page on another origin can still make the browser send a request here.
 * Requests that carry a foreign Origin are refused, which keeps the ledger
 * out of reach of whatever else the user has open.
 *
 * A missing Origin has to stay readable: a browser omits the header on a
 * same-origin GET and on the navigation that loads the editor, so demanding it
 * everywhere would refuse the page its own data.
 *
 * A mutation is different. Browsers always send Origin on a non-GET request,
 * so an absent one did not come from the editor, and `null` is precisely what a
 * sandboxed iframe or a `data:` document sends -- the shapes a cross-site page
 * reaches for once a real Origin gets it refused. Treating either as same-origin
 * left `POST /folder` open to any page the user had in another tab, which is why
 * writes now require a real loopback Origin.
 */
export function isAllowedOrigin(originHeader, method = "GET") {
  const origin = String(originHeader || "").trim();
  if (!origin || origin === "null") {
    return !MUTATING_METHODS.has(String(method || "GET").toUpperCase());
  }
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
export function renderStateFile(statementsDir, ledgerDir = "") {
  return `${JSON.stringify({
    version: 1,
    statementsDir: statementsDir || "",
    ledgerPath: statementsDir && ledgerDir ? join(ledgerDir, DB_FILENAME) : "",
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
 * predictable: the JSON ledger, `state.json`, the statements themselves.
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
 * The parent directory is opened first and the file is opened through its
 * descriptor, so the directory read from is the one that was checked. A
 * symlinked parent still resolves on the way in -- that is a supported way to
 * keep statements -- but it resolves once, and cannot be swapped afterwards to
 * move the read somewhere else.
 */
export async function readCapped(path, max) {
  let fh;
  try {
    fh = await withDir(dirname(path), (at) =>
      open(`${at}/${basename(path)}`, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK),
    );
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
 * Run `fn` against a path that stays bound to `dir` however `dir` is reached.
 *
 * A descriptor names an inode, not a name. Once the directory is open, swapping
 * any component of the path it was reached through cannot redirect what follows:
 * the work lands in the directory that was checked, or it fails. Re-opening by
 * pathname between the check and the write is exactly the window this closes --
 * `O_NOFOLLOW` on the final component never covered it, because it says nothing
 * about the parents.
 *
 * The directory is still reached by pathname, and a symlinked parent still
 * resolves. That is deliberate: `~/Statements` pointing at an external drive is
 * a supported way to keep statements, and `GET /browse` follows symlinked
 * folders on purpose. What changes is that the resolution happens once, and
 * every operation after it is anchored to the result rather than repeating it.
 *
 * `/proc/self/fd` is how Node reaches a descriptor-relative path at all: it has
 * no `openat`, and no `openat2` to refuse symlinks outright. Omakei ships as an
 * Omarchy plugin, so Linux is a safe floor.
 */
export async function withDir(dir, fn) {
  const dh = await open(dir, FS.O_RDONLY | FS.O_DIRECTORY);
  try {
    return await fn(`/proc/self/fd/${dh.fd}`);
  } finally {
    await dh.close().catch(() => {});
  }
}

/**
 * Create `dir` and any missing parent, anchoring each step to the descriptor of
 * the directory it is created in.
 *
 * `mkdir(dir, { recursive: true })` walks the path by name, so a component
 * swapped mid-walk moves the rest of the walk with it -- and a state directory
 * created somewhere else is one every later write then anchors to faithfully.
 * Each level here is created through its parent's descriptor instead, so the
 * walk cannot be steered after it starts.
 *
 * The state directory is the only directory Omakei creates.
 */
async function ensureDir(dir) {
  let dh = await open(sep, FS.O_RDONLY | FS.O_DIRECTORY);
  try {
    for (const part of resolve(dir).split(sep).filter(Boolean)) {
      const at = `/proc/self/fd/${dh.fd}/${part}`;
      try {
        await mkdir(at);
      } catch (err) {
        if (err?.code !== "EEXIST") throw err;
      }
      const next = await open(at, FS.O_RDONLY | FS.O_DIRECTORY);
      await dh.close().catch(() => {});
      dh = next;
    }
  } finally {
    await dh.close().catch(() => {});
  }
}

/**
 * Create the private directory that holds `statementsDir`'s ledger, and carry
 * over a ledger that still sits in the folder from before it moved. Returns the
 * directory.
 *
 * `ledgers/` and the ledger's own directory are created 0700 through their
 * parent's descriptor, opened without following a link, and tightened to 0700
 * if they already exist looser and are ours. `ledger-db.mjs` checks the result
 * again before every write, so a directory this could not make private is
 * refused there rather than trusted here.
 */
export async function prepareLedgerDir(statementsDir, { env = process.env, home = homedir() } = {}) {
  const stateDir = stateDirFor(env, home);
  const ledgerDir = ledgerDirFor(statementsDir, env, home);
  await ensureDir(stateDir);
  await withDir(stateDir, async (state) => {
    const ledgers = await openPrivateChild(state, LEDGERS_DIRNAME);
    try {
      const own = await openPrivateChild(`/proc/self/fd/${ledgers.fd}`, basename(ledgerDir));
      await own.close().catch(() => {});
    } finally {
      await ledgers.close().catch(() => {});
    }
  });
  await adoptLegacyLedger(statementsDir, ledgerDir);
  return ledgerDir;
}

async function openPrivateChild(at, name) {
  try {
    await mkdir(`${at}/${name}`, 0o700);
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
  }
  const dh = await open(`${at}/${name}`, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW);
  try {
    const info = await dh.stat();
    if (info.uid === process.getuid?.() && (info.mode & 0o077) !== 0) await dh.chmod(0o700);
    return dh;
  } catch (err) {
    await dh.close().catch(() => {});
    throw err;
  }
}

/**
 * Copy `omakei-ledger.sqlite` out of the attached folder into the private
 * directory, once, if the private one does not exist yet.
 *
 * The old file is read through the folder's descriptor with `O_NOFOLLOW`, like
 * every other read here, so a link in its place is not followed. The copy is
 * written to an unpredictable temp name and published with `link`, which
 * refuses to replace a ledger another process published first. A hot journal
 * beside the old file means it may be mid-write, so it is left for next time.
 * The old file itself is left where it is: it is the user's.
 */
async function adoptLegacyLedger(statementsDir, ledgerDir) {
  const present = await withDir(ledgerDir, (at) => lstat(`${at}/${DB_FILENAME}`)).then(
    () => true,
    (err) => err?.code !== "ENOENT",
  );
  if (present) return;
  const legacy = join(statementsDir, DB_FILENAME);
  const journal = await lstat(`${legacy}-journal`).then(
    () => true,
    () => false,
  );
  if (journal) return;
  const bytes = await readCapped(legacy, MAX_LEDGER_BYTES);
  if (!bytes || bytes.length === 0) return;
  const tmpName = `.${DB_FILENAME}.${randomBytes(8).toString("hex")}.tmp`;
  await withDir(ledgerDir, async (at) => {
    let fh;
    try {
      fh = await open(`${at}/${tmpName}`, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
      await fh.writeFile(bytes);
      await fh.sync();
      await fh.close();
      fh = undefined;
      await link(`${at}/${tmpName}`, `${at}/${DB_FILENAME}`).catch((err) => {
        if (err?.code !== "EEXIST") throw err;
      });
    } finally {
      await fh?.close().catch(() => {});
      await unlink(`${at}/${tmpName}`).catch(() => {});
    }
  });
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
 *
 * Both the create and the rename go through the destination directory's own
 * descriptor, so the directory this publishes into is the one that was opened,
 * whatever happens to its path meanwhile.
 */
export async function writeAtomic(path, text) {
  const name = basename(path);
  const tmpName = `.${name}.${randomBytes(8).toString("hex")}.tmp`;
  await withDir(dirname(path), async (at) => {
    let fh;
    try {
      fh = await open(`${at}/${tmpName}`, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
      await fh.writeFile(text, "utf8");
      await fh.sync();
      await fh.close();
      fh = undefined;
      await rename(`${at}/${tmpName}`, `${at}/${name}`);
    } catch (err) {
      await unlink(`${at}/${tmpName}`).catch(() => {});
      throw err;
    } finally {
      await fh?.close().catch(() => {});
    }
  });
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
  try {
    await ensureDir(stateDir);
    await withDir(stateDir, async (at) => {
      let fh;
      try {
        fh = await open(
          `${at}/${REVISION_FILENAME}`,
          FS.O_WRONLY | FS.O_CREAT | FS.O_TRUNC | FS.O_NOFOLLOW,
          0o600,
        );
        await fh.writeFile(`${Date.now()}\n`, "utf8");
      } finally {
        await fh?.close().catch(() => {});
      }
    });
  } catch {
    /* nothing the user can do about it, and nothing that should fail a save */
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
export function createLedgerApi({ env = process.env, home = homedir(), ownerUid = process.getuid?.() } = {}) {
  const stateDir = stateDirFor(env, home);
  const statePath = join(stateDir, "state.json");
  const revisionPath = join(stateDir, REVISION_FILENAME);
  const seedDir = String(env.OMAKEI_STATEMENTS_DIR || "").trim();

  let cached;

  async function currentDir() {
    if (cached === undefined) {
      const raw = await readCapped(statePath, MAX_STATE_BYTES);
      const text = raw ? raw.toString("utf8") : "";
      const saved = parseStateFile(text);
      // The env var is a convenience default for development. It seeds the
      // same state every other install writes, so no code path is dev-only.
      cached = saved?.statementsDir || (seedDir ? resolve(expandHome(seedDir, home)) : null);
      if (!saved && cached) await persist(cached);
      // A state file written before the ledger moved to SQLite names the JSON
      // as `ledgerPath`, and nothing else would ever rewrite it: it changes only
      // on attach. An agent following docs/ledger.md would then read a ledger
      // nothing writes any more, so the server brings it up to date on startup.
      else if (saved && text !== renderStateFile(saved.statementsDir, ledgerDirFor(saved.statementsDir, env, home)))
        await persist(saved.statementsDir);
    }
    return cached;
  }

  async function persist(dir) {
    cached = dir;
    await ensureDir(stateDir);
    await writeAtomic(statePath, renderStateFile(dir, dir ? ledgerDirFor(dir, env, home) : ""));
    // Attaching or detaching changes which ledger is the current one, which is
    // as much a change to the widget as editing the ledger itself.
    await bumpRevision();
  }

  const bumpRevision = () => bumpRevisionAt(stateDir);

  /**
   * The ledger as it is in the database, with the etag of exactly that version.
   * The two come from one read on purpose: an etag taken from a second read
   * could name a version the caller never saw.
   *
   * A database that is refused -- a symlink, over the cap, not an Omakei ledger
   * -- reads as no ledger.
   */
  async function readLedgerAt(dir) {
    return (await readLedgerDb(await prepareLedgerDir(dir, { env, home }))) ?? { ledger: null, etag: "" };
  }

  /**
   * Writes are serialized. The database's transaction already makes the check
   * and the write atomic against every process; the queue keeps this server's
   * own saves from waiting on SQLite's lock for each other.
   */
  let writeQueue = Promise.resolve();
  function serialize(fn) {
    const run = writeQueue.then(fn, fn);
    // Keep the chain alive whatever this write did, but never leave an
    // unhandled rejection behind it.
    writeQueue = run.then(
      () => {},
      () => {},
    );
    return run;
  }

  /** One round-trip with everything the editor needs to paint. */
  async function stateBody() {
    const dir = await currentDir();
    if (!dir || !(await isDirectory(dir))) {
      return { folder: null, ledger: null, ledgerPath: "", ledgerEtag: "", home };
    }
    const { ledger, etag } = await readLedgerAt(dir);
    return {
      folder: { path: dir, name: basename(dir) },
      ledger,
      ledgerPath: join(ledgerDirFor(dir, env, home), DB_FILENAME),
      ledgerEtag: etag,
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
    if (!(await isSameUserPeer(req, ownerUid))) {
      deny(res, 403, "Omakei answers only to the user running it");
      return true;
    }
    const method = (req.method ?? "GET").toUpperCase();
    if (!isAllowedOrigin(req.headers?.origin, method)) {
      deny(res, 403, "Cross-origin requests are refused");
      return true;
    }

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

        /**
         * A save says which version it was derived from, and is refused if the
         * file has moved on since. The editor holds the whole ledger in memory
         * for as long as its tab is open, so without this its next save quietly
         * reinstates everything the file gained in the meantime -- a rule added
         * by `omakei-categorize.mjs`, or a save from a second tab. The lost
         * write could be minutes old; nothing about it looks like a race.
         *
         * The refusal carries the current ledger, so a client can merge and
         * retry without a second round-trip. "" is the etag of no ledger yet.
         */
        const ifMatch = req.headers?.["if-match"];
        if (typeof ifMatch !== "string") {
          deny(res, 428, "A ledger write must carry If-Match");
          return true;
        }

        const body = await serialize(async () => {
          let result;
          try {
            const ledgerDir = await prepareLedgerDir(dir, { env, home });
            result = await updateLedgerDb(ledgerDir, ({ etag }) => (ifMatch === etag ? parsed : null));
          } catch (err) {
            if (err instanceof LedgerShapeError) {
              return { status: 400, payload: { error: `Invalid ledger: ${err.message}` } };
            }
            throw err;
          }
          if (!result) {
            // A link, a FIFO, or something that is not an Omakei ledger sits where
            // the ledger goes, or its directory is not private to this user. It
            // is not written through and not replaced.
            return { status: 409, payload: { error: "The ledger in this folder cannot be opened safely" } };
          }
          if (!result.written) {
            return {
              status: 412,
              payload: {
                error: "The ledger changed since you read it",
                etag: result.etag,
                ledger: result.ledger,
              },
            };
          }
          await bumpRevision();
          return { status: 200, payload: { ok: true, etag: result.etag } };
        });

        json(res, body.status, body.payload);
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
