/**
 * Drives the API over a real socket, because that is how both the dev server
 * and an installed plugin reach it. The guards especially: they are only
 * meaningful against actual headers.
 */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
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
