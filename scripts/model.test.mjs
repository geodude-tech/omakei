import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(ROOT, "Model.js"), "utf8");
const Model = new Function(
  `${src}\nreturn { editorUrl, editorQuery, emptySummary, summarize, parseSetAsides, openEditorCommand, shellQuote, stateFilePath, ledgerPathFromState };`,
)();

test("editorUrl carries the month the popup was showing", () => {
  const summary = {
    hasData: true,
    month: "2026-08",
    spent: 4312.55,
    income: 8200,
    net: 3387.45,
    uncategorized: 17,
    allocated: 500,
    setAsides: [{ id: "tax", name: "Filing taxes", amount: 500 }],
  };
  assert.equal(Model.editorQuery(summary), "m=2026-08");
  assert.equal(
    Model.editorUrl("http://127.0.0.1:8080/", summary),
    "http://127.0.0.1:8080/?m=2026-08",
  );
  // An empty month still opens the editor, just without pinning a month.
  assert.equal(Model.editorQuery({ month: "" }), "");
  assert.equal(Model.editorUrl("http://127.0.0.1:8080/", { month: "" }), "http://127.0.0.1:8080/");
});

test("openEditorCommand routes through the plugin's own opener", () => {
  const summary = {
    hasData: true,
    month: "2026-08",
    spent: 1,
    income: 2,
    net: 1,
    uncategorized: 0,
    allocated: 0,
    setAsides: [],
  };
  const url = Model.editorUrl("http://127.0.0.1:8080/", summary);
  assert.equal(
    Model.openEditorCommand(
      "http://127.0.0.1:8080/",
      summary,
      "/home/user/.config/omarchy/plugins/omakei",
    ),
    `'/home/user/.config/omarchy/plugins/omakei/scripts/omakei-open' '${url}'`,
  );
  // A trailing slash on the plugin dir must not double up.
  assert.equal(
    Model.openEditorCommand("http://127.0.0.1:8080/", summary, "/plugins/omakei/"),
    `'/plugins/omakei/scripts/omakei-open' '${url}'`,
  );
  // No ledger yet still opens the editor — just with no cell values to carry.
  assert.equal(
    Model.openEditorCommand(
      "http://127.0.0.1:8080/",
      { month: "" },
      "/plugins/omakei",
    ),
    "'/plugins/omakei/scripts/omakei-open' 'http://127.0.0.1:8080/'",
  );
  // Without a plugin directory there is nothing that can start the editor.
  assert.equal(Model.openEditorCommand("http://127.0.0.1:8080/", summary), "");
  assert.equal(Model.openEditorCommand("", summary, "/plugins/omakei"), "");
});

test("summarize totals a month of transactions", () => {
  const summary = Model.summarize(
    [
      { date: "2026-08-02", amount: -12.5, description: "Coffee", categoryId: "coffee" },
      { date: "2026-08-03", amount: 3000, description: "Pay", categoryId: "income" },
      { date: "2026-08-04", amount: -40, description: "Unknown", categoryId: null },
      { date: "2026-07-01", amount: -9, description: "Old", categoryId: null },
    ],
    "2026-08",
    [{ id: "tax", name: "Taxes", amount: 100 }],
  );
  assert.equal(summary.spent, 52.5);
  assert.equal(summary.income, 3000);
  assert.equal(summary.net, 2847.5);
  assert.equal(summary.uncategorized, 1);
  assert.equal(summary.allocated, 100);
  assert.equal(Model.editorQuery(summary), "m=2026-08");
});

test("the widget finds the ledger from the server's state file", () => {
  assert.equal(
    Model.stateFilePath("/run/state", "/home/user"),
    "/run/state/omakei/state.json",
  );
  assert.equal(
    Model.stateFilePath("", "/home/user"),
    "/home/user/.local/state/omakei/state.json",
  );

  assert.equal(
    Model.ledgerPathFromState(
      JSON.stringify({ version: 1, statementsDir: "/s", ledgerPath: "/s/omakei-ledger.json" }),
    ),
    "/s/omakei-ledger.json",
  );
  // Derived from the folder when only the folder is recorded.
  assert.equal(
    Model.ledgerPathFromState(JSON.stringify({ version: 1, statementsDir: "/s/" })),
    "/s/omakei-ledger.json",
  );
  // No folder attached, unknown version, or unreadable file: no path.
  assert.equal(Model.ledgerPathFromState(JSON.stringify({ version: 1, statementsDir: "" })), "");
  assert.equal(Model.ledgerPathFromState(JSON.stringify({ version: 2, ledgerPath: "/x" })), "");
  assert.equal(Model.ledgerPathFromState("not json"), "");
  assert.equal(Model.ledgerPathFromState(""), "");
});
