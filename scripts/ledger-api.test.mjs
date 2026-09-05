/**
 * Drives the API over a real socket, because that is how both the dev server
 * and an installed plugin reach it. The guards especially: they are only
 * meaningful against actual headers.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  existsSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  createLedgerApi,
  isAllowedOrigin,
  isLoopbackHost,
  parseStateFile,
  renderStateFile,
  safeJoin,
  withDir,
  writeAtomic,
} from "./ledger-api.mjs";

const temps = [];

function tempTree() {
  const root = mkdtempSync(join(tmpdir(), "omakei-api-"));
  temps.push(root);
  const home = join(root, "home");
  const statements = join(home, "Statements");
  mkdirSync(join(statements, "Credit"), { recursive: true });
  return { root, home, statements };
}

after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true });
});

/** Start the handler on a loopback port and return a fetch bound to it. */
async function serve(home) {
  const api = createLedgerApi({
    env: { XDG_STATE_HOME: join(home, ".state") },
    home,
  });
  const server = createServer((req, res) => {
    api.handle(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("not mine");
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    api,
    base,
    // A browser always sends Origin on a non-GET, and the server now requires
    // one there. The harness mirrors the browser so a test that is not about
    // the guard does not have to restate it; a test that is about the guard
    // sets its own Origin and keeps it.
    call: (path, init = {}) => {
      const method = (init.method ?? "GET").toUpperCase();
      const headers = { ...(init.headers ?? {}) };
      const named = Object.keys(headers).some((k) => k.toLowerCase() === "origin");
      if (method !== "GET" && method !== "HEAD" && !named) headers.origin = base;
      return fetch(`${base}/__omakei${path}`, { ...init, headers });
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test("attaching a folder makes the ledger readable, writable, and findable", async () => {
  const { home, statements } = tempTree();
  writeFileSync(
    join(statements, "checking.csv"),
    "Date,Description,Amount\n2026-08-02,COFFEE SHOP,-4.50\n2026-08-03,PAYROLL,3000.00\n",
  );
  writeFileSync(join(statements, "Credit", "card.csv"), "Date,Description,Amount\n2026-08-04,GROCERY,-52.10\n");
  const s = await serve(home);
  try {
    // Nothing attached yet.
    let state = await (await s.call("/state")).json();
    assert.equal(state.folder, null);
    assert.equal(state.ledgerPath, "");

    // Attach it.
    const attached = await s.call("/folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: statements }),
    });
    assert.equal(attached.status, 200);
    state = await attached.json();
    assert.equal(state.folder.path, statements);
    assert.equal(state.folder.name, "Statements");
    assert.equal(state.ledgerPath, join(statements, "omakei-ledger.json"));

    // The state file the widget reads now points at that ledger.
    const recorded = parseStateFile(readFileSync(s.api.statePath, "utf8"));
    assert.equal(recorded.statementsDir, statements);

    // Statements are listed, subfolders included, with stable relative paths.
    const listing = await (await s.call("/statements")).json();
    assert.deepEqual(
      listing.files.map((f) => f.path),
      ["Credit/card.csv", "checking.csv"],
    );

    const file = await (await s.call("/statements/file?path=Credit%2Fcard.csv")).json();
    assert.match(file.text, /GROCERY/);

    // Writing lands in the attached folder.
    const ledger = {
      version: 1,
      savedAt: "2026-08-27T00:00:00.000Z",
      selectedMonth: "2026-08",
      transactions: [{ id: "a", date: "2026-08-02", amount: -4.5 }],
      rules: [],
      setAsides: [],
    };
    const put = await s.call("/ledger", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ledger),
    });
    assert.equal(put.status, 200);
    const onDisk = JSON.parse(readFileSync(join(statements, "omakei-ledger.json"), "utf8"));
    assert.equal(onDisk.transactions[0].id, "a");

    // And comes straight back on the next open.
    state = await (await s.call("/state")).json();
    assert.equal(state.ledger.transactions.length, 1);
  } finally {
    await s.close();
  }
});

test("detaching forgets the folder without touching the files", async () => {
  const { home, statements } = tempTree();
  writeFileSync(join(statements, "a.csv"), "Date,Description,Amount\n2026-08-02,X,-1\n");
  const s = await serve(home);
  try {
    await s.call("/folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: statements }),
    });
    const state = await (await s.call("/folder", { method: "DELETE" })).json();
    assert.equal(state.folder, null);
    assert.equal(state.ledgerPath, "");
    assert.equal(readFileSync(join(statements, "a.csv"), "utf8").includes("X"), true);
  } finally {
    await s.close();
  }
});

test("a folder that is not a folder is refused", async () => {
  const { home, statements } = tempTree();
  const file = join(statements, "a.csv");
  writeFileSync(file, "x");
  const s = await serve(home);
  try {
    for (const path of [file, join(statements, "nope")]) {
      const res = await s.call("/folder", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
      });
      assert.equal(res.status, 400);
    }
  } finally {
    await s.close();
  }
});

test("statement reads cannot escape the attached folder", async () => {
  const { home, statements } = tempTree();
  writeFileSync(join(home, "secret.csv"), "Date,Description,Amount\n2026-01-01,SECRET,-1\n");
  const s = await serve(home);
  try {
    await s.call("/folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: statements }),
    });
    for (const rel of ["../secret.csv", "..%2Fsecret.csv", "/etc/hosts"]) {
      const res = await s.call(`/statements/file?path=${encodeURIComponent(rel)}`);
      assert.equal(res.ok, false, `${rel} should not be readable`);
    }
    // Nor a file inside the folder that is not a statement.
    writeFileSync(join(statements, "notes.md"), "hi");
    assert.equal((await s.call("/statements/file?path=notes.md")).ok, false);
  } finally {
    await s.close();
  }
});

test("a rebound host name or a foreign origin is refused", async () => {
  const { home, statements } = tempTree();
  const s = await serve(home);
  try {
    const evil = await fetch(`${s.base}/__omakei/state`, {
      headers: { host: "ledger.example.com", origin: "https://ledger.example.com" },
    });
    assert.equal(evil.status, 403);

    const crossOrigin = await s.call("/folder", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://example.com" },
      body: JSON.stringify({ path: statements }),
    });
    assert.equal(crossOrigin.status, 403);

    // The editor's own page still works.
    assert.equal(
      (await s.call("/state", { headers: { origin: s.base } })).status,
      200,
    );
  } finally {
    await s.close();
  }
});

test("a malformed ledger never reaches disk", async () => {
  const { home, statements } = tempTree();
  const s = await serve(home);
  try {
    await s.call("/folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: statements }),
    });
    for (const body of ["not json", JSON.stringify({ version: 2 }), JSON.stringify({})]) {
      const res = await s.call("/ledger", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body,
      });
      assert.equal(res.status, 400);
    }
    assert.throws(() => readFileSync(join(statements, "omakei-ledger.json")));
  } finally {
    await s.close();
  }
});

test("browse walks real directories and reports where it is", async () => {
  const { home, statements } = tempTree();
  const s = await serve(home);
  try {
    const at = await (await s.call(`/browse?path=${encodeURIComponent(home)}`)).json();
    assert.equal(at.path, home);
    assert.deepEqual(
      at.entries.map((e) => e.name),
      ["Statements"],
    );
    const down = await (await s.call(`/browse?path=${encodeURIComponent(statements)}`)).json();
    assert.deepEqual(
      down.entries.map((e) => e.name),
      ["Credit"],
    );
    assert.equal(down.parent, home);
    assert.equal((await s.call("/browse?path=%2Fnot%2Fa%2Fplace")).status, 404);
  } finally {
    await s.close();
  }
});

test("browse counts the statements at and just below each folder", async () => {
  // The count is the whole reason the picker beats a generic file dialog: it is
  // what tells you which of a dozen folders is the one holding your exports.
  const { home, statements } = tempTree();
  writeFileSync(join(statements, "Credit", "aug.csv"), "Date,Description,Amount\n");
  writeFileSync(join(statements, "Credit", "jul.qfx"), "<OFX></OFX>\n");
  writeFileSync(join(statements, "notes.md"), "not a statement\n");
  mkdirSync(join(home, "Photos"), { recursive: true });
  const s = await serve(home);
  try {
    const at = await (await s.call(`/browse?path=${encodeURIComponent(home)}`)).json();
    const byName = Object.fromEntries(at.entries.map((e) => [e.name, e.statements]));
    // One level below the row, so a `Credit/` subfolder still shows up.
    assert.equal(byName.Statements, 2);
    assert.equal(byName.Photos, 0);
    // Two levels for where you are standing, which is the folder you attach.
    assert.equal(at.statements, 2);
  } finally {
    await s.close();
  }
});

test("browse follows a symlinked folder and refuses one it cannot read", async () => {
  // With no path box in the picker, a folder that does not appear in a listing
  // cannot be reached at all — and `~/Statements` pointing at an external drive
  // is a normal way to keep them.
  const { home, root } = tempTree();
  const drive = join(root, "drive");
  mkdirSync(join(drive, "Credit"), { recursive: true });
  writeFileSync(join(drive, "Credit", "aug.csv"), "Date,Description,Amount\n");
  symlinkSync(drive, join(home, "LinkedDrive"));
  symlinkSync(join(root, "gone"), join(home, "Broken"));
  const locked = join(home, "locked");
  mkdirSync(locked, { recursive: true });
  chmodSync(locked, 0o000);
  const s = await serve(home);
  try {
    const at = await (await s.call(`/browse?path=${encodeURIComponent(home)}`)).json();
    const byName = Object.fromEntries(at.entries.map((e) => [e.name, e.statements]));
    assert.equal(byName.LinkedDrive, 1, "a symlinked folder is listed, and counted through");
    assert.equal("Broken" in byName, false, "a broken symlink is not a folder");

    // Reachable means attachable: the path is real either way.
    const attached = await s.call("/folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: join(home, "LinkedDrive") }),
    });
    assert.equal(attached.status, 200);

    // A folder you cannot read is a dead end, not a server fault.
    const denied = await s.call(`/browse?path=${encodeURIComponent(locked)}`);
    assert.equal(denied.status, 403);
    assert.match((await denied.json()).error, /could not read/i);
  } finally {
    chmodSync(locked, 0o700);
    await s.close();
  }
});

test("browse offers the places a folder can be reached from", async () => {
  const { home } = tempTree();
  mkdirSync(join(home, "Documents"), { recursive: true });
  const s = await serve(home);
  try {
    const at = await (await s.call(`/browse?path=${encodeURIComponent(home)}`)).json();
    assert.equal(at.home, home);
    const names = at.places.map((p) => p.name);
    assert.deepEqual(names, ["Home", "Documents"]);
    // Downloads and Desktop do not exist in the tree, so they are not offered:
    // the picker has no path box, so a dead shortcut is a dead end.
    assert.equal(
      at.places.find((p) => p.name === "Home").path,
      home,
    );
  } finally {
    await s.close();
  }
});

test("OMAKEI_STATEMENTS_DIR seeds the same state an attach would write", async () => {
  const { home, statements } = tempTree();
  const api = createLedgerApi({
    env: { XDG_STATE_HOME: join(home, ".state"), OMAKEI_STATEMENTS_DIR: statements },
    home,
  });
  const state = await api.stateBody();
  assert.equal(state.folder.path, statements);
  assert.equal(parseStateFile(readFileSync(api.statePath, "utf8")).statementsDir, statements);
});

/*
 * The seed only seeds. These two pin why `npm run dev:isolated` moves
 * XDG_STATE_HOME rather than making the env var win: a saved folder always
 * beats the variable, so the only way to develop off a sandbox is to develop
 * against a state dir that has no saved folder in it.
 */

test("a saved folder beats OMAKEI_STATEMENTS_DIR", async () => {
  const { home, root, statements } = tempTree();
  const stateDir = join(home, ".state", "omakei");
  const sandbox = join(root, "sandbox");
  mkdirSync(sandbox, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "state.json"), renderStateFile(statements));

  const api = createLedgerApi({
    env: { XDG_STATE_HOME: join(home, ".state"), OMAKEI_STATEMENTS_DIR: sandbox },
    home,
  });

  // The attached folder wins, and the seed does not rewrite it.
  assert.equal((await api.stateBody()).folder.path, statements);
  assert.equal(parseStateFile(readFileSync(api.statePath, "utf8")).statementsDir, statements);
});

test("a separate XDG_STATE_HOME leaves the real state file untouched", async () => {
  const { home, root, statements } = tempTree();
  const realStateDir = join(home, ".state", "omakei");
  const realStatePath = join(realStateDir, "state.json");
  const sandbox = join(root, "sandbox");
  mkdirSync(sandbox, { recursive: true });
  mkdirSync(realStateDir, { recursive: true });
  writeFileSync(realStatePath, renderStateFile(statements));
  const before = readFileSync(realStatePath, "utf8");

  const api = createLedgerApi({
    env: { XDG_STATE_HOME: join(root, "dev-state"), OMAKEI_STATEMENTS_DIR: sandbox },
    home,
  });

  assert.equal((await api.stateBody()).folder.path, sandbox);
  assert.notEqual(api.statePath, realStatePath);
  assert.equal(readFileSync(realStatePath, "utf8"), before);
});

/* ------------------------------------------------------- disk-path hardening
 *
 * Everything below fails against a `readFile(path)` / `writeFile(path + ".tmp")`
 * implementation. They are the reason the reads are descriptor-bound and the
 * temp file is exclusive.
 */

/** Attach `statements` and return the running server. */
async function attached(home, statements) {
  const s = await serve(home);
  await s.call("/folder", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: statements }),
  });
  return s;
}

test("a symlink in place of the ledger is not followed", async () => {
  const { root, home, statements } = tempTree();
  const secret = join(root, "secret.json");
  writeFileSync(secret, JSON.stringify({ version: 1, transactions: [{ id: "leaked" }], rules: [] }));
  const s = await attached(home, statements);
  try {
    symlinkSync(secret, join(statements, "omakei-ledger.json"));
    const state = await (await s.call("/state")).json();
    assert.equal(state.ledger, null, "a symlinked ledger must read as no ledger at all");
  } finally {
    await s.close();
  }
});

test("a ledger larger than the cap never enters the server", async () => {
  const { home, statements } = tempTree();
  const s = await attached(home, statements);
  try {
    // Deliberately *valid* JSON above the cap. A sparse file would be rejected
    // for being unparseable and would prove nothing about the size limit.
    const filler = "x".repeat(1024);
    const transactions = Array.from({ length: 21 * 1024 }, (_, i) => ({ id: `t${i}`, note: filler }));
    const path = join(statements, "omakei-ledger.json");
    writeFileSync(path, JSON.stringify({ version: 1, transactions, rules: [] }));
    assert.ok(statSync(path).size > 20 * 1024 * 1024, "fixture must exceed the cap");
    const state = await (await s.call("/state")).json();
    assert.equal(state.ledger, null, "an oversized ledger is refused, not parsed");
  } finally {
    await s.close();
  }
});

test("a statement that is a symlink is refused", async () => {
  const { root, home, statements } = tempTree();
  const outside = join(root, "outside.csv");
  writeFileSync(outside, "Date,Description,Amount\n2026-08-02,SECRET,-1\n");
  writeFileSync(join(statements, "real.csv"), "Date,Description,Amount\n2026-08-02,SHOP,-2\n");
  symlinkSync(outside, join(statements, "linked.csv"));
  const s = await attached(home, statements);
  try {
    // readdir reports the symlink as a symlink, so it is not offered either.
    const listing = await (await s.call("/statements")).json();
    assert.deepEqual(listing.files.map((f) => f.name), ["real.csv"]);

    // And asking for it by name anyway does not read through it.
    const res = await s.call("/statements/file?path=linked.csv");
    assert.equal(res.status, 404);
  } finally {
    await s.close();
  }
});

test("an oversized statement is refused with 413, not read", async () => {
  const { home, statements } = tempTree();
  const path = join(statements, "huge.csv");
  writeFileSync(path, "Date,Description,Amount\n");
  truncateSync(path, 33 * 1024 * 1024);
  const s = await attached(home, statements);
  try {
    const res = await s.call("/statements/file?path=huge.csv");
    assert.equal(res.status, 413);
  } finally {
    await s.close();
  }
});

test("a FIFO left in the folder does not hang the server", async () => {
  const { home, statements } = tempTree();
  const fifo = join(statements, "pipe.csv");
  try {
    execFileSync("mkfifo", [fifo]);
  } catch {
    return; // no mkfifo on this machine; nothing to assert
  }
  const s = await attached(home, statements);
  try {
    // Without O_NONBLOCK this open blocks until someone writes to the pipe,
    // which is never, and the request never returns.
    const res = await Promise.race([
      s.call("/statements/file?path=pipe.csv"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("open blocked")), 4000)),
    ]);
    assert.equal(res.status, 404, "a FIFO is not a regular file");
  } finally {
    await s.close();
  }
});

test("a symlink at the predictable temp path cannot capture the write", async () => {
  const { root, home, statements } = tempTree();
  const canary = join(root, "canary.txt");
  writeFileSync(canary, "untouched");
  const s = await attached(home, statements);
  try {
    // This is exactly the old temp name. Under the previous writeAtomic the
    // ledger JSON went straight through it and overwrote the canary.
    symlinkSync(canary, join(statements, "omakei-ledger.json.tmp"));
    const put = await s.call("/ledger", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, transactions: [], rules: [], selectedMonth: "2026-08" }),
    });
    assert.equal(put.status, 200);
    assert.equal(readFileSync(canary, "utf8"), "untouched", "the write must not follow the planted link");
    assert.match(readFileSync(join(statements, "omakei-ledger.json"), "utf8"), /"version":1/);
  } finally {
    await s.close();
  }
});

test("a symlinked destination is replaced, not written through", async () => {
  const { root, home, statements } = tempTree();
  const canary = join(root, "canary.json");
  writeFileSync(canary, "untouched");
  const s = await attached(home, statements);
  try {
    const dest = join(statements, "omakei-ledger.json");
    symlinkSync(canary, dest);
    const put = await s.call("/ledger", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, transactions: [], rules: [], selectedMonth: "2026-08" }),
    });
    assert.equal(put.status, 200);
    assert.equal(readFileSync(canary, "utf8"), "untouched");
    assert.equal(statSync(dest).isSymbolicLink?.() ?? false, false);
    assert.throws(() => readlinkSync(dest), "the link itself was replaced by the real file");
  } finally {
    await s.close();
  }
});

test("a symlinked state file is not followed on startup", async () => {
  const { root, home, statements } = tempTree();
  const elsewhere = join(root, "elsewhere.json");
  writeFileSync(elsewhere, renderStateFile(statements));
  const stateDir = join(home, ".state", "omakei");
  mkdirSync(stateDir, { recursive: true });
  symlinkSync(elsewhere, join(stateDir, "state.json"));
  const s = await serve(home);
  try {
    const state = await (await s.call("/state")).json();
    assert.equal(state.folder, null, "a symlinked state file records no folder");
  } finally {
    await s.close();
  }
});

test("no temp file is left behind by a successful write", async () => {
  const { home, statements } = tempTree();
  const s = await attached(home, statements);
  try {
    await s.call("/ledger", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, transactions: [], rules: [], selectedMonth: "2026-08" }),
    });
    const { readdirSync } = await import("node:fs");
    const leftovers = readdirSync(statements).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, []);
  } finally {
    await s.close();
  }
});

test("the revision file changes whenever the widget would need to re-read", async () => {
  const { home, statements } = tempTree();
  const s = await serve(home);
  try {
    // Attaching is itself a change: it decides which ledger is current.
    await s.call("/folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: statements }),
    });
    const afterAttach = readFileSync(s.api.revisionPath, "utf8");
    assert.match(afterAttach, /^\d+\n$/, "the token is only there to make the file change");

    await new Promise((r) => setTimeout(r, 2));
    await s.call("/ledger", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 1, transactions: [], rules: [], selectedMonth: "2026-08" }),
    });
    const afterSave = readFileSync(s.api.revisionPath, "utf8");
    assert.notEqual(afterSave, afterAttach, "saving the ledger has to move it");

    await new Promise((r) => setTimeout(r, 2));
    await s.call("/folder", { method: "DELETE" });
    assert.notEqual(readFileSync(s.api.revisionPath, "utf8"), afterSave, "so does detaching");
  } finally {
    await s.close();
  }
});

test("a rejected ledger does not move the revision", async () => {
  const { home, statements } = tempTree();
  const s = await attached(home, statements);
  try {
    const before = readFileSync(s.api.revisionPath, "utf8");
    await new Promise((r) => setTimeout(r, 2));
    const bad = await s.call("/ledger", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ version: 9, nope: true }),
    });
    assert.equal(bad.status, 400);
    assert.equal(readFileSync(s.api.revisionPath, "utf8"), before, "nothing changed, so nothing to re-read");
  } finally {
    await s.close();
  }
});

test("a symlinked revision file is not written through", async () => {
  const { root, home, statements } = tempTree();
  const canary = join(root, "canary.txt");
  writeFileSync(canary, "untouched");
  const s = await serve(home);
  try {
    mkdirSync(join(home, ".state", "omakei"), { recursive: true });
    symlinkSync(canary, join(home, ".state", "omakei", "ledger-revision"));
    const put = await s.call("/folder", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: statements }),
    });
    assert.equal(put.status, 200, "a hostile revision file must not break attaching");
    assert.equal(readFileSync(canary, "utf8"), "untouched");
  } finally {
    await s.close();
  }
});

test("a sandboxed page cannot write with a null or absent Origin", async () => {
  const { home, statements } = tempTree();
  const s = await serve(home);
  try {
    // What a sandboxed iframe or a data: document sends. It used to read as
    // same-origin, which left every write route open to a page in another tab.
    for (const origin of ["null", ""]) {
      const attach = await s.call("/folder", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ path: statements }),
      });
      assert.equal(attach.status, 403);

      const wipe = await s.call("/folder", { method: "DELETE", headers: { origin } });
      assert.equal(wipe.status, 403);

      const write = await s.call("/ledger", {
        method: "PUT",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ version: 1, transactions: [], rules: [] }),
      });
      assert.equal(write.status, 403);
    }

    // Nothing was attached by any of that.
    assert.equal((await (await s.call("/state")).json()).folder, null);

    // The editor's own page still writes.
    const ok = await s.call("/folder", {
      method: "POST",
      headers: { "content-type": "application/json", origin: s.base },
      body: JSON.stringify({ path: statements }),
    });
    assert.equal(ok.status, 200);
  } finally {
    await s.close();
  }
});

test("a directory swapped after it is opened cannot redirect the write", async () => {
  const { root } = tempTree();
  const real = join(root, "real");
  const decoy = join(root, "decoy");
  const live = join(root, "live");
  mkdirSync(real);
  mkdirSync(decoy);
  symlinkSync(real, live);

  await withDir(live, async (at) => {
    // Exactly the window a pathname-based write leaves open: the directory was
    // checked, and the name it was checked through now means something else.
    rmSync(live);
    symlinkSync(decoy, live);
    await writeAtomic(`${at}/landed.json`, "{}\n");
  });

  // The write followed the descriptor, not the name.
  assert.equal(existsSync(join(real, "landed.json")), true);
  assert.equal(existsSync(join(decoy, "landed.json")), false);
});

test("a symlinked parent is still a supported place to keep statements", async () => {
  const { root } = tempTree();
  const real = join(root, "elsewhere");
  const link = join(root, "Statements");
  mkdirSync(real);
  symlinkSync(real, link);

  // `~/Statements` pointing at an external drive has to keep working: anchoring
  // resolves the parent once, it does not refuse one.
  await writeAtomic(join(link, "omakei-ledger.json"), "{}\n");
  assert.equal(readFileSync(join(real, "omakei-ledger.json"), "utf8"), "{}\n");
});

test("path and header helpers", () => {
  assert.equal(safeJoin("/root", "a/b.csv"), "/root/a/b.csv");
  assert.equal(safeJoin("/root", "../escape.csv"), null);
  assert.equal(safeJoin("/root", "/etc/hosts"), null);

  assert.equal(isLoopbackHost("127.0.0.1:8080"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("[::1]:8080"), true);
  assert.equal(isLoopbackHost("example.com"), false);
  assert.equal(isLoopbackHost(""), false);

  // A read may arrive without an Origin: browsers omit it on a same-origin GET
  // and on the navigation that loads the editor.
  assert.equal(isAllowedOrigin("", "GET"), true);
  assert.equal(isAllowedOrigin("null", "GET"), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:8080", "GET"), true);
  assert.equal(isAllowedOrigin("https://example.com", "GET"), false);

  // A write may not. An absent Origin did not come from the editor, and "null"
  // is what a sandboxed iframe sends -- the way a cross-site page gets around
  // having its real Origin refused.
  assert.equal(isAllowedOrigin("", "POST"), false);
  assert.equal(isAllowedOrigin("null", "POST"), false);
  assert.equal(isAllowedOrigin("null", "DELETE"), false);
  assert.equal(isAllowedOrigin("null", "PUT"), false);
  assert.equal(isAllowedOrigin("http://127.0.0.1:8080", "POST"), true);

  assert.match(renderStateFile("/s"), /"ledgerPath":"\/s\/omakei-ledger\.json"/);
  assert.equal(parseStateFile(renderStateFile("")), null);
});
