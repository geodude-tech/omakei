import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { ledgerDirFor, renderStateFile, stateDirFor } from "./ledger-api.mjs";
import { readLedgerDb } from "./ledger-db.mjs";
import { run, scanFolder, takeLock } from "./omakei-import.mjs";

const SCRIPT = fileURLToPath(new URL("./omakei-import.mjs", import.meta.url));

/** A scratch home with a statements folder attached, all invented. */
function scratch() {
  const root = mkdtempSync(join(tmpdir(), "omakei-import-"));
  chmodSync(root, 0o700);
  const home = join(root, "home");
  const drop = join(root, "drop");
  mkdirSync(join(drop, "Credit_Card"), { recursive: true });
  mkdirSync(join(drop, "Checking_and_Savings"), { recursive: true });
  const env = { XDG_STATE_HOME: join(home, ".local/state"), HOME: home };
  const stateDir = stateDirFor(env, home);
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(stateDir, "state.json"),
    renderStateFile(drop, ledgerDirFor(drop, env, home)),
    { mode: 0o600 },
  );
  const old = new Date(Date.now() - 10 * 60 * 1000);
  return {
    root,
    home,
    drop,
    env,
    stateDir,
    ledgerDir: ledgerDirFor(drop, env, home),
    /** Write a file that finished landing ten minutes ago. */
    put(rel, body) {
      const path = join(drop, rel);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, body);
      utimesSync(path, old, old);
      return path;
    },
    async run(...argv) {
      let out = "";
      let err = "";
      const code = await run(argv, {
        env,
        home,
        out: { write: (s) => (out += s) },
        err: { write: (s) => (err += s) },
        notify: (text) => (this.notices ??= []).push(text),
      });
      return { code, out, err };
    },
    async json(...argv) {
      const r = await this.run("--json", ...argv);
      assert.equal(r.code, 0, r.err);
      return JSON.parse(r.out);
    },
    async ledger() {
      return (await readLedgerDb(this.ledgerDir))?.ledger ?? null;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

const CARD_CSV = [
  "Posted Date,Reference Number,Payee,Address,Amount",
  "07/21/2026,1,SAFEWAY #1234,ANYTOWN NY,-42.50",
  "07/23/2026,2,ZQX UNKNOWN SHOP,ANYTOWN NY,-9.99",
  "07/25/2026,3,PAYMENT - THANK YOU,,100.00",
].join("\n");

/** A one-page PDF of monospace text, enough for `pdftotext -layout` to give the lines back. */
function textPdf(lines) {
  const esc = (s) => s.replace(/[\\()]/g, (c) => `\\${c}`);
  const content = [
    "BT",
    "/F1 8 Tf",
    "10 TL",
    "20 770 Td",
    ...lines.map((l) => `(${esc(l)}) Tj T*`),
    "ET",
  ].join("\n");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let out = "%PDF-1.4\n";
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

/** A Bank of America card statement, invented, in the layout the converter reads. */
function boaPdf({ rows, newBalanceOff = 0 }) {
  const money = (n) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
  const purchases = rows.filter((r) => r.amount >= 0).reduce((a, r) => a + r.amount, 0);
  const credits = rows.filter((r) => r.amount < 0).reduce((a, r) => a + r.amount, 0);
  return textPdf([
    "                 BANK OF AMERICA                   Account Number:      1111 2222 3333 4444",
    "Statement Closing Date                     08/10/2026",
    `Previous Balance                            ${money(0)}`,
    ...rows.map(
      (r) =>
        `${r.trans}         ${r.posted}      ${r.payee}                    2940        4444        ${r.amount.toFixed(2)}`,
    ),
    "08/10         08/10      INTEREST CHARGED ON PURCHASES                        0.00",
    `        TOTAL PURCHASES AND ADJUSTMENTS FOR THIS PERIOD          ${money(purchases)}`,
    `        TOTAL PAYMENTS AND OTHER CREDITS FOR THIS PERIOD         ${money(credits)}`,
    `        TOTAL INTEREST CHARGED FOR THIS PERIOD                   ${money(0)}`,
    `New Balance Total                            ${money(purchases + credits + newBalanceOff)}`,
  ]);
}

const PDF_ROWS = [
  { trans: "07/20", posted: "07/21", payee: "SAFEWAY #1234     ANYTOWN NY", amount: 42.5 },
  { trans: "07/22", posted: "07/23", payee: "ZQX PLACE         ANYTOWN NY", amount: 15.49 },
];

let hasPdftotext = true;
try {
  execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
} catch (err) {
  hasPdftotext = err?.code !== "ENOENT";
}

/** Every path under `dir`, with its mode. */
function modes(dir) {
  const found = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      found.push({ p, mode: statSync(p).mode & 0o777, dir: e.isDirectory() });
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return found;
}

test("imports a CSV from a subfolder, categorized, and a second run adds nothing", async (t) => {
  const s = scratch();
  t.after(s.cleanup);
  s.put("Credit_Card/2026-07.csv", CARD_CSV);

  const first = await s.run("--notify");
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /^3 new transactions, 1 needs? a category/);
  assert.deepEqual(s.notices, [first.out.split("\n")[0]]);

  const ledger = await s.ledger();
  assert.equal(ledger.transactions.length, 3);
  assert.ok(ledger.transactions.every((tx) => tx.accountKind === "credit"));
  assert.equal(
    ledger.transactions.find((tx) => /SAFEWAY/.test(tx.description)).categoryId,
    "groceries",
  );
  assert.equal(ledger.importedFiles.length, 1);
  assert.equal(ledger.importedFiles[0].status, "imported");
  assert.equal(ledger.importedFiles[0].added, 3);
  assert.ok(existsSync(join(s.stateDir, "ledger-revision")));

  const second = await s.run("--notify");
  assert.equal(second.code, 0);
  assert.match(second.out, /^Nothing new\./);
  assert.match(second.out, /1 file\(s\) already imported/);
  assert.equal(s.notices.length, 1, "no notice when nothing is new");
  assert.equal((await s.ledger()).transactions.length, 3);
});

test("the same rows under another name or folder are not added twice", async (t) => {
  const s = scratch();
  t.after(s.cleanup);
  s.put("Credit_Card/a.csv", CARD_CSV);
  await s.run();
  s.put("Credit_Card/copy of a.csv", `${CARD_CSV}\n`);
  s.put("Credit_Card/older/a (1).csv", `${CARD_CSV}\n\n`);
  const summary = await s.json();
  assert.equal(summary.added, 0);
  assert.equal(summary.duplicates.length, 2);
  assert.equal((await s.ledger()).transactions.length, 3);
});

test("hostile filenames are read as data and printed harmlessly", async (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const names = [
    "Credit_Card/new\nline.csv",
    "Credit_Card/$(touch PWNED).csv",
    "Credit_Card/-rf --notify.csv",
    `Credit_Card/quote"'\`.csv`,
    "Credit_Card/escape \u001b[31mred.csv",
    "Credit_Card/right-to-left \u202egpj.csv",
    "Credit_Card/ünïcødé 账单.csv",
    `Credit_Card/${"x".repeat(200)}.csv`,
  ];
  names.forEach((name, i) => s.put(name, CARD_CSV.replace("SAFEWAY #1234", `SAFEWAY #${i}`)));
  const r = await s.run();
  assert.equal(r.code, 0, r.err);
  assert.ok(!r.out.includes("\u001b"), "no terminal escapes reach the output");
  assert.ok(!r.out.includes("\u202e"), "no direction overrides either");
  const ledger = await s.ledger();
  assert.equal(ledger.importedFiles.length, names.length);
  assert.deepEqual(ledger.importedFiles.map((f) => f.path).sort(), [...names].sort());
  assert.equal(existsSync(join(s.drop, "Credit_Card", "PWNED")), false);
  assert.equal(existsSync(join(process.cwd(), "PWNED")), false);
});

test("files it cannot read are reported once, never fatal", async (t) => {
  const s = scratch();
  t.after(s.cleanup);
  s.put("Credit_Card/garbage.csv", "\u0000\u0001not,a\nstatement at all\u00ff");
  s.put("Credit_Card/headers-only.csv", "Posted Date,Reference Number,Payee,Address,Amount\n");
  s.put("Credit_Card/fake.pdf", "%PDF-1.4 this is not really a pdf");
  s.put(
    "Credit_Card/binary.ofx",
    Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 37) % 256)),
  );
  s.put("Credit_Card/good.csv", CARD_CSV);

  const first = await s.json("--notify");
  assert.equal(first.added, 3);
  assert.equal(first.failed.length, 4);
  for (const f of first.failed) assert.ok(f.reason.length <= 120 && !/\d{2}\.\d{2}/.test(f.reason));
  assert.match(s.notices[0], /4 files could not be read/);

  const second = await s.json("--notify");
  assert.equal(second.failed.length, 0, "a failed file is not retried until it changes");
  assert.equal(second.alreadySeen.length, 5);

  s.put(
    "Credit_Card/headers-only.csv",
    `${"Posted Date,Reference Number,Payee,Address,Amount"}\n07/30/2026,9,ZQX FIXED,,-1.00\n`,
  );
  const third = await s.json();
  assert.equal(third.added, 1, "a changed file is read again");
});

test("links, FIFOs, dot files, and files outside the folder are never read", async (t) => {
  const s = scratch();
  t.after(s.cleanup);
  const outside = join(s.root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.csv"), CARD_CSV);
  symlinkSync(join(outside, "secret.csv"), join(s.drop, "Credit_Card", "link.csv"));
  symlinkSync(outside, join(s.drop, "Credit_Card", "linked-dir"));
  symlinkSync("/dev/zero", join(s.drop, "Credit_Card", "zero.csv"));
  execFileSync("mkfifo", [join(s.drop, "Credit_Card", "pipe.csv")]);
  s.put("Credit_Card/.hidden.csv", CARD_CSV);
  s.put(".git/x.csv", CARD_CSV);

  const summary = await s.json();
  assert.equal(summary.added, 0);
  assert.equal(summary.imported.length + summary.failed.length + summary.duplicates.length, 0);
  assert.equal(await s.ledger(), null, "nothing to record, nothing written");
});

test("a file still being written waits for the next run", async (t) => {
  const s = scratch();
  t.after(s.cleanup);
  writeFileSync(join(s.drop, "Credit_Card", "landing.csv"), CARD_CSV); // mtime: now
  const first = await s.json();
  assert.equal(first.added, 0);
  assert.deepEqual(
    first.waiting.map((w) => w.path),
    ["Credit_Card/landing.csv"],
  );
  const later = await s.json("--settle", "0");
  assert.equal(later.added, 3);
});

test("a PDF beside its converted CSV is left to the CSV", async (t) => {
  const s = scratch();
  t.after(s.cleanup);
  s.put("Credit_Card/eStmt.csv", CARD_CSV);
  s.put("Credit_Card/eStmt.pdf", "%PDF-1.4 not parsed");
  const summary = await s.json();
  assert.deepEqual(summary.shadowed, ["Credit_Card/eStmt.pdf"]);
  assert.equal(summary.failed.length, 0);
});

test(
  "a Bank of America PDF is converted; one that does not reconcile is refused",
  { skip: !hasPdftotext },
  async (t) => {
    const s = scratch();
    t.after(s.cleanup);
    s.put("Credit_Card/eStmt_2026-08-10.pdf", boaPdf({ rows: PDF_ROWS }));
    s.put("Credit_Card/off by a cent.pdf", boaPdf({ rows: PDF_ROWS, newBalanceOff: 0.01 }));
    const summary = await s.json();
    assert.equal(summary.added, 2);
    assert.deepEqual(summary.imported, ["Credit_Card/eStmt_2026-08-10.pdf"]);
    assert.deepEqual(
      summary.failed.map((f) => f.path),
      ["Credit_Card/off by a cent.pdf"],
    );
    const ledger = await s.ledger();
    assert.ok(ledger.transactions.every((tx) => tx.amount < 0 && tx.accountKind === "credit"));

    // The same purchases from a CSV export add nothing.
    s.put(
      "Credit_Card/export.csv",
      "Posted Date,Reference Number,Payee,Address,Amount\n07/21/2026,2940,SAFEWAY #1234 ANYTOWN NY,,-42.50\n",
    );
    const again = await s.json();
    assert.equal(again.added, 0);
  },
);

test("concurrent runs import once", async (t) => {
  const s = scratch();
  t.after(s.cleanup);
  for (let i = 0; i < 20; i++)
    s.put(`Credit_Card/m${i}.csv`, CARD_CSV.replaceAll("2026", String(2000 + i)));
  const once = () =>
    new Promise((resolve) =>
      execFile(
        process.execPath,
        [SCRIPT, "--json"],
        { env: { ...process.env, ...s.env } },
        (error, stdout, stderr) => resolve({ error, stdout, stderr }),
      ),
    );
  const results = await Promise.all([once(), once(), once(), once()]);
  for (const r of results) assert.equal(r.error, null, r.stderr);
  const ledger = await s.ledger();
  assert.equal(ledger.transactions.length, 60);
  assert.equal(ledger.importedFiles.length, 20);
  assert.equal(existsSync(join(s.stateDir, "import.lock")), false, "the lock is cleaned up");
});

test("a live lock is respected; a dead or ancient one is taken over", async (t) => {
  const s = scratch();
  t.after(s.cleanup);
  s.put("Credit_Card/a.csv", CARD_CSV);
  const lock = join(s.stateDir, "import.lock");

  writeFileSync(lock, `${process.ppid} ${Date.now()}\n`, { mode: 0o600 });
  const blocked = await s.run();
  assert.match(blocked.out, /Another import is running/);
  assert.equal(await s.ledger(), null);

  writeFileSync(lock, `999999999 ${Date.now()}\n`, { mode: 0o600 });
  assert.equal((await s.json()).added, 3, "dead pid");

  s.put("Credit_Card/b.csv", CARD_CSV.replaceAll("2026", "2025"));
  writeFileSync(lock, `${process.ppid} ${Date.now() - 31 * 60 * 1000}\n`, { mode: 0o600 });
  assert.equal((await s.json()).added, 3, "older than any run");

  symlinkSync(join(s.root, "elsewhere"), lock);
  const release = takeLock(s.stateDir);
  assert.ok(release, "a planted link is cleared, not written through");
  assert.equal(existsSync(join(s.root, "elsewhere")), false);
  assert.equal(statSync(lock).mode & 0o777, 0o600);
  release();
  assert.equal(existsSync(lock), false);
});

test("everything it writes is owner-only and inside the state directory; the drop folder is untouched", async (t) => {
  const s = scratch();
  t.after(s.cleanup);
  chmodSync(s.stateDir, 0o700);
  s.put("Credit_Card/a.csv", CARD_CSV);
  s.put("Checking_and_Savings/bad.csv", "nope");
  const before = modes(s.drop).map((m) => `${m.p}:${m.mode}`);
  const prevUmask = process.umask(0o022);
  try {
    await s.run("--notify");
  } finally {
    process.umask(prevUmask);
  }
  assert.deepEqual(
    modes(s.drop).map((m) => `${m.p}:${m.mode}`),
    before,
    "nothing added to or changed in the statements folder",
  );
  for (const m of modes(join(s.home, ".local/state"))) {
    assert.equal(m.mode & 0o077, 0, `${m.p} is ${m.mode.toString(8)}`);
  }
  assert.deepEqual(readdirSync(s.root).sort(), ["drop", "home"]);
});

test("--status lists what was read without touching anything", async (t) => {
  const s = scratch();
  t.after(s.cleanup);
  s.put("Credit_Card/a.csv", CARD_CSV);
  s.put("Credit_Card/bad.csv", "nope");
  await s.run();
  const r = await s.run("--status");
  assert.match(r.out, /Credit_Card\/a\.csv {2}\(imported, 3 added\)/);
  assert.match(r.out, /Credit_Card\/bad\.csv {2}\(failed: /);
  const usage = await s.run("--bogus");
  assert.equal(usage.code, 2);
});

test("no folder attached is an error, not a crash", async (t) => {
  const s = scratch();
  t.after(s.cleanup);
  rmSync(join(s.stateDir, "state.json"));
  const r = await s.run();
  assert.equal(r.code, 1);
  assert.match(r.err, /No statements folder attached/);
});

test("a relative statements folder is refused rather than read from the working directory", async (t) => {
  const s = scratch();
  t.after(s.cleanup);
  writeFileSync(join(s.stateDir, "state.json"), renderStateFile("drop"), { mode: 0o600 });
  const r = await s.run();
  assert.equal(r.code, 1);
  assert.match(r.err, /No statements folder attached/);
});

test("scanFolder stops at four levels and never lists links", () => {
  const root = mkdtempSync(join(tmpdir(), "omakei-scan-"));
  try {
    mkdirSync(join(root, "a/b/c/d/e"), { recursive: true });
    writeFileSync(join(root, "a/b/c/d/x.csv"), "x");
    writeFileSync(join(root, "a/b/c/d/e/too-deep.csv"), "x");
    writeFileSync(join(root, "a/notes.md"), "x");
    symlinkSync(join(root, "a"), join(root, "loop"));
    assert.deepEqual(
      scanFolder(root).map((f) => f.path),
      ["a/b/c/d/x.csv"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the importer has no way to reach the network", () => {
  const source = readFileSync(SCRIPT, "utf8");
  assert.doesNotMatch(
    source,
    /\bfetch\(|node:(net|http|https|dgram|tls|dns)\b|WebSocket|XMLHttpRequest/,
  );
  assert.doesNotMatch(source, /tmpdir|\/tmp\b/);
});
