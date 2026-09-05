# Spec: Ledger Server

_Status: documents existing behavior as of 2026-08-28. Traces to `docs/intent/omakei.md`._

## Objective

Be the one process that touches disk. The editor is a browser page with no
filesystem of its own, so a small Node server owns the attached folder: it
remembers which folder it is, lists and reads the statements in it, writes
`omakei-ledger.json` back, and records the folder's real path where the bar
widget can find it.

The intent requires "nothing leaves the machine" and "time-to-display,
time-to-save, and sync must stay immediate." Both fall on this component: it is
the only network listener, and it inlines the ledger into the first HTML response
so the editor paints real numbers without a fetch.

**User:** the editor SPA (every read and write), `omakei-serve.mjs` and the Vite
dev server (both mount the same handler), and — indirectly — the bar widget,
which reads `state.json` to locate the ledger.

**Success:**

- The editor gets the folder, the ledger, and `$HOME` in one `/state` response
  (or inlined into the page, with the fetch as fallback).
- A save writes atomically into the attached folder and bumps the file the widget
  watches, so the bar updates without being asked.
- Development and an installed plugin run byte-identical disk code — anything only
  one of them can do is a bug.
- Nothing on the network, and nothing else in the browser, can reach the ledger:
  loopback socket, loopback `Host`, same-origin only.
- A symlink, a FIFO, or an over-size file left in the folder cannot make the
  server follow a path out of the folder or block on a read.

## Tech Stack

Node standard library only — `node:http`, `node:fs/promises`, `node:crypto`,
`node:path`, `node:os`. **No npm dependencies**: `omarchy plugin add` clones the
git tree and never runs `npm install`. The server scripts ship as source, not in
`dist/`.

## Commands

```
Serve (as installers do):  npm run start          # dist/ on 127.0.0.1:8080
Dev:                        npm run dev            # Vite + same handler
Dev (sandboxed):            npm run dev:isolated   # XDG_STATE_HOME + OMAKEI_STATEMENTS_DIR under .dev/
Test:                       npm test               # scripts/ledger-api.test.mjs (largest single suite)
```

## Project Structure

```
scripts/ledger-api.mjs          → createLedgerApi(): the handler, path guards, disk primitives, state file
scripts/ledger-api-plugin.mjs   → mounts createLedgerApi() as Vite middleware (apply: "serve")
scripts/omakei-serve.mjs        → node:http server over dist/, mounts the same handler
scripts/omakei-html-plugin.mjs  → fills index.html placeholders on the dev server (build leaves them)
scripts/page-shell.mjs          → renderShell(): injects theme + inline state into index.html
scripts/omakei-open             → starts the server on demand when the widget opens Omakei
src/lib/finance/server.ts       → the browser client for the API
```

State lives in `$XDG_STATE_HOME/omakei/` (default `~/.local/state/omakei/`):

```
state.json        → { version: 1, statementsDir, ledgerPath }   — the widget reads this
ledger-revision   → a timestamp token, rewritten on every ledger change   — the widget watches this
```

## API

All routes are under `/__omakei`. Every route requires a loopback socket and a
loopback `Host` header; otherwise `403`.

`Origin` is judged by method. A read (`GET`) allows a loopback `Origin` or none,
because a browser omits the header on a same-origin `GET` and on the navigation
that loads the editor. A write (`POST`, `PUT`, `PATCH`, `DELETE`) requires a real
loopback `Origin`: browsers always send one on a non-GET, so an absent header did
not come from the editor, and `null` is what a sandboxed iframe or a `data:`
document sends — the shape a cross-site page reaches for once its real `Origin`
is refused. Treating either as same-origin left every write route open to a page
in another tab.

The same loopback socket and `Host` guard covers the static routes in
`scripts/omakei-serve.mjs`, not just this handler: that server fills the SPA
shell with the ledger, so an unguarded `GET /` would hand the whole ledger to
anything that reaches the port.

| Method + route | Does |
|---|---|
| `GET /state` | `{ folder, ledger, ledgerPath, home }` — one round trip to paint |
| `POST /folder` `{path}` | Attach a folder (must exist). Persists `state.json`, bumps revision |
| `DELETE /folder` | Detach. Persists empty `state.json`, bumps revision |
| `GET /browse?path=` | Directory listing for the editor's folder picker (returns real paths), plus the statement count at and just below each row, the count two levels below `path`, `home`, and the `places` worth one click (home dirs and mounted volumes). Symlinked folders are followed — the picker has no path box, so a hidden folder is an unreachable one. `403` for a folder that cannot be read |
| `GET /statements` | Every statement file under the folder, recursively, codepoint-sorted |
| `GET /statements/file?path=` | One statement's text, `safeJoin`-checked, extension-checked, capped at 32 MB |
| `PUT /ledger` | Validate `isLedgerPayload`, write atomically, bump revision |

## Code Style

Disk access goes through two primitives, and nothing else opens a file:

```js
// Read: check on the descriptor, read from the same descriptor, bound the bytes.
const fh = await open(path, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
const info = await fh.stat();
if (!info.isFile()) return null;
if (info.size > max) return null;
// ...read at most `max` bytes...

// Write: unpredictable temp name, O_EXCL, fsync, atomic rename in the same dir.
const tmp = join(dir, `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
const fh = await open(tmp, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o600);
await fh.writeFile(text, "utf8");
await fh.sync();
await fh.close();
await rename(tmp, path);
```

Conventions:

- **`handle(req, res)` returns a boolean.** `false` means "not my request, fall
  through to static files." Both hosts rely on this.
- **The state file shape is a contract.** `renderStateFile` emits exactly
  `{ version: 1, statementsDir, ledgerPath }`. `Panel.qml` and
  `omakei-read-ledger.mjs` parse it; the ledger-contract doc documents it for
  agents. Do not add or rename keys without updating all three.
- **Every failure is bounded and quiet.** `bumpRevision` swallows its errors (a
  missed live-refresh is not a failed save). `readCapped` returns `null` for
  anything that is not a readable regular file within the cap.
- **Caps are constants at the top of the file:** ledger 20 MB, statement 32 MB,
  state file 64 KB.

## Behavior this spec fixes in place

### The env seed is a default, not an override

`OMAKEI_STATEMENTS_DIR` seeds `state.json` only when there is no saved
`statementsDir`. `currentDir()` prefers the saved value, and when it falls back
to the seed it immediately `persist()`s it through the same path an attach uses.
Consequence: on a machine that has ever attached a folder, the variable is
ignored. `dev:isolated` works by moving `XDG_STATE_HOME` to a fresh `.dev/state`
where there is no saved folder to lose to — not by letting the variable win.
This is env-only; there is no dev-only code path.

### Reads are bounded on the way in and the way out

`readLedger` runs on every `/state` call into a long-lived server, so a ledger
over 20 MB is refused there, not only on `PUT`. `page-shell.mjs` additionally
refuses to inline a state payload over 4 MB, falling back to the `/state` fetch.

### The revision file is written, never read here

`bumpRevision` opens `ledger-revision` with `O_TRUNC` (not through a rename —
nothing depends on its atomicity) and writes `Date.now()`. It is bumped on every
`PUT /ledger`, every `POST /folder`, and every `DELETE /folder`. The widget
watches it and never reads it (see the bar-widget spec).

### One HTML response carries the ledger

`omakei-serve.mjs` serves any non-asset path as `index.html` run through
`renderShell`, which fills `<!--omakei:head-->` with the user's live Omarchy
theme and `<!--omakei:state-->` with `<script>window.__OMAKEI_STATE=…</script>`.
`cache-control: no-store` on the shell (theme-dependent, data-bearing);
`immutable` on hashed assets. The dev server does the same fill via
`omakei-html-plugin.mjs`, which is a no-op during `build` so `dist/` ships with
the placeholders intact.

## Testing Strategy

`scripts/ledger-api.test.mjs` (593 lines, the largest suite) is the guard. It
covers, with a temp `XDG_STATE_HOME` and a temp folder:

- Every route's happy path and its `403`/`400`/`404`/`405`/`409`/`413`.
- The loopback socket, `Host`, and `Origin` checks, including that a `null` or
  absent `Origin` cannot write.
- `safeJoin` rejecting `../` escapes and absolute paths.
- `readCapped` refusing a symlink, a directory, and an over-cap file.
- `writeAtomic` leaving no temp file on failure and refusing a pre-placed symlink.
- The env-seed-is-a-default semantics.
- `renderStateFile` / `parseStateFile` round-tripping.

`omakei-read-ledger.test.mjs` and `omarchy-theme.test.mjs` cover the reader and
theme loader that share this module.

## Boundaries

**Always:**
- Serve on `127.0.0.1` only, and keep that enforced rather than assumed:
  `omakei-serve.mjs` refuses to start on a non-loopback `OMAKEI_HOST`, and
  `scripts/omakei-open` pins the widget's URL setting to loopback so the setting
  can choose the port but never the interface.
- Keep the loopback socket, `Host`, and `Origin` guards, and keep them in front
  of the static routes too. This is a personal ledger; nothing else on the
  network or in the browser may reach it.
- Go through `readCapped` / `writeAtomic` for every disk touch. If the widget or
  anything else needs something new off disk, add it here — do not open a second
  path.
- Keep the dev plugin and `omakei-serve.mjs` mounting the identical handler.
- Keep the server dependency-free.

**Ask first:**
- Adding a route, or a key to `state.json`.
- Writing anything into the user's folder that is not `omakei-ledger.json`
  (also an open question in the ledger-contract spec).
- Raising a cap.

**Never:**
- Let `OMAKEI_STATEMENTS_DIR` override a saved folder — it would rewrite the
  user's real `state.json` and point their bar at dev data.
- Bind to a non-loopback host. Not by default and not on request: the server
  exits rather than honour a LAN-facing `OMAKEI_HOST`.
- Follow a symlink at the final path component (`O_NOFOLLOW` on every open).
- Touch disk by pathname where a directory descriptor is available: reads,
  writes, renames, and directory creation all go through `withDir` /
  `ensureDir` so a swapped parent cannot redirect them.

## Success Criteria

Verified against the current suite (2026-08-28).

1. **Met.** `ledger-api.test.mjs` passes, including the guard, cap, and symlink
   cases.
2. **Met.** `npm run dev` and `npm run start` both serve the editor with the
   ledger inlined (`renderShell` in both `omakei-serve.mjs` and
   `omakei-html-plugin.mjs`).
3. **Met.** A `PUT /ledger` rewrites `omakei-ledger.json` atomically and bumps
   `ledger-revision`.
4. **Met.** A cross-origin request and a non-loopback `Host` both get `403`,
   on the static routes as well as the API, and a `null` or absent `Origin`
   cannot reach a write route.
5. **Met.** `dev:isolated` reads and writes only under `.dev/`, leaving the real
   `state.json` untouched.

## Open Questions

1. **`GET /browse` discloses the directory tree to any same-origin page.** It is
   loopback-only and same-origin-only, but a compromised localhost page could
   walk the filesystem. The picker needs it; a scope limit (e.g. under `$HOME`)
   might be worth it.
2. **No auth token.** Same-origin is the only thing standing between another
   localhost service and the ledger. On a single-user Omarchy machine this is the
   documented model, but it is worth stating as a decision rather than an
   omission.
3. **`cached` folder path is process-lifetime.** `createLedgerApi` caches
   `currentDir()` and only `persist()` updates it. An external edit to
   `state.json` while the server runs is not noticed until restart. Fine for the
   widget (separate process) but a latent surprise.
4. **Resolved (2026-09-02): operations are bound to directory descriptors.**
   `O_NOFOLLOW` covers the last component only, so a swapped *parent* used to
   move a read or a write with it. Every disk touch now opens its directory
   first and works through `/proc/self/fd/<fd>/name`, which names an inode
   rather than a path: `readCapped`, `writeAtomic` (create and rename both),
   and the revision write are anchored, and the state directory is created a
   level at a time through each parent's descriptor instead of
   `mkdir(recursive)`.

   A symlinked parent still *resolves* — `~/Statements` pointing at an external
   drive is supported, and `GET /browse` follows symlinked folders on purpose.
   What changed is that it resolves once. Node still has no `openat2`, so this
   does not refuse symlinks outright; it removes the window between the check
   and the use, which is what the reachable attack needed.
