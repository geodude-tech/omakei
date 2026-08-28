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
    call: (path, init) => fetch(`${base}/__omakei${path}`, init),
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

test("path and header helpers", () => {
  assert.equal(safeJoin("/root", "a/b.csv"), "/root/a/b.csv");
  assert.equal(safeJoin("/root", "../escape.csv"), null);
  assert.equal(safeJoin("/root", "/etc/hosts"), null);

  assert.equal(isLoopbackHost("127.0.0.1:8080"), true);
  assert.equal(isLoopbackHost("localhost"), true);
  assert.equal(isLoopbackHost("[::1]:8080"), true);
  assert.equal(isLoopbackHost("example.com"), false);
  assert.equal(isLoopbackHost(""), false);

  assert.equal(isAllowedOrigin(""), true);
  assert.equal(isAllowedOrigin("null"), true);
  assert.equal(isAllowedOrigin("http://127.0.0.1:8080"), true);
  assert.equal(isAllowedOrigin("https://example.com"), false);

  assert.match(renderStateFile("/s"), /"ledgerPath":"\/s\/omakei-ledger\.json"/);
  assert.equal(parseStateFile(renderStateFile("")), null);
});
