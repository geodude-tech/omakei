import assert from "node:assert/strict";
import { test } from "node:test";
import {
  expandHome,
  isLedgerPayload,
  isLocalhost,
  readEnvValue,
  resolveStatementsDir,
} from "./local-statements-plugin.mjs";

test("readEnvValue parses quoted and export lines", () => {
  const text = [
    "# comment",
    "OTHER=nope",
    'export FOLIO_STATEMENTS_DIR="/home/user/Financial_Statements"',
  ].join("\n");
  assert.equal(readEnvValue(text, "FOLIO_STATEMENTS_DIR"), "/home/user/Financial_Statements");
  assert.equal(readEnvValue("# only comments\n", "FOLIO_STATEMENTS_DIR"), "");
});

test("resolveStatementsDir prefers process env over dotenv text", () => {
  assert.equal(
    resolveStatementsDir({
      processEnv: { FOLIO_STATEMENTS_DIR: "/from/env" },
      envFileText: "FOLIO_STATEMENTS_DIR=/from/file",
      home: "/home/user",
    }),
    "/from/env",
  );
  assert.equal(
    resolveStatementsDir({
      processEnv: {},
      envFileText: "FOLIO_STATEMENTS_DIR=~/Financial_Statements",
      home: "/home/user",
    }),
    "/home/user/Financial_Statements",
  );
  assert.equal(resolveStatementsDir({ processEnv: {}, envFileText: "" }), null);
});

test("expandHome handles ~ and ~/path", () => {
  assert.equal(expandHome("~", "/home/user"), "/home/user");
  assert.equal(
    expandHome("~/Financial_Statements", "/home/user"),
    "/home/user/Financial_Statements",
  );
  assert.equal(expandHome("/abs/path", "/home/user"), "/abs/path");
});

test("isLedgerPayload rejects sample and incomplete files", () => {
  const ok = { version: 1, transactions: [], rules: [], isSample: false };
  assert.equal(isLedgerPayload(ok), true);
  assert.equal(isLedgerPayload({ ...ok, isSample: true }), false);
  assert.equal(isLedgerPayload({ version: 1, transactions: [] }), false);
  assert.equal(isLedgerPayload(null), false);
});

test("isLocalhost allows loopback addresses only", () => {
  assert.equal(isLocalhost({ socket: { remoteAddress: "127.0.0.1" } }), true);
  assert.equal(isLocalhost({ socket: { remoteAddress: "::1" } }), true);
  assert.equal(isLocalhost({ socket: { remoteAddress: "::ffff:127.0.0.1" } }), true);
  assert.equal(isLocalhost({ socket: { remoteAddress: "8.8.8.8" } }), false);
});
