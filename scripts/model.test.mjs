import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(ROOT, "Model.js"), "utf8");
const Model = new Function(
  `${src}\nreturn { editorUrl, editorQuery, emptySummary, summarize, parseSetAsides, openEditorCommand, shellQuote };`,
)();

test("editorUrl copies month cell values onto the Omakei URL", () => {
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
  assert.equal(
    Model.editorQuery(summary),
    "m=2026-08&sp=4312.55&inc=8200&n=3387.45&u=17&r=500&sa=tax%09Filing%20taxes%09500",
  );
  assert.equal(
    Model.editorUrl("http://127.0.0.1:8080/", summary),
    "http://127.0.0.1:8080/?m=2026-08&sp=4312.55&inc=8200&n=3387.45&u=17&r=500&sa=tax%09Filing%20taxes%09500",
  );
  assert.equal(
    Model.editorUrl("http://127.0.0.1:8080/", Model.emptySummary("2026-08")),
    "http://127.0.0.1:8080/",
  );
  assert.equal(
    Model.openEditorCommand("http://127.0.0.1:8080/", summary),
    "omarchy launch browser 'http://127.0.0.1:8080/?m=2026-08&sp=4312.55&inc=8200&n=3387.45&u=17&r=500&sa=tax%09Filing%20taxes%09500'",
  );
});

test("openEditorCommand uses the plugin's opener when it knows where it lives", () => {
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
      Model.emptySummary("2026-08"),
      "/plugins/omakei",
    ),
    "'/plugins/omakei/scripts/omakei-open' 'http://127.0.0.1:8080/'",
  );
});

test("summarize feeds editorQuery from a month of transactions", () => {
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
  const query = Model.editorQuery(summary);
  assert.match(query, /^m=2026-08&sp=52\.5&inc=3000&n=2847\.5&u=1&r=100&sa=tax%09Taxes%09100$/);
});
