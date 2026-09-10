import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// The popup offers these ids to omakei-categorize.mjs, which validates against
// this same list. Model.js cannot import it -- it is ES5 for the QML engine --
// so the test is what keeps the two copies honest.
import { CATEGORIES } from "../src/lib/finance/categories.ts";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const src = readFileSync(join(ROOT, "Model.js"), "utf8");
const Model = new Function(
  `${src}\nreturn { editorUrl, editorQuery, emptySummary, summarize, parseSetAsides, openEditorCommand, shellQuote, revisionFilePath, parseLedger, parseReaderOutput, latestMonth, openingMonth, dailySpend, daysInMonth, categoryOptions, categorizeCommand, rollingSummary, trailingStart, barTooltip, currentDay };`,
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

test("latestMonth picks the newest YYYY-MM present, or '' for none", () => {
  assert.equal(
    Model.latestMonth([
      { date: "2026-03-11", amount: 1 },
      { date: "2026-11-02", amount: 1 },
      { date: "2026-07-30", amount: 1 },
    ]),
    "2026-11",
  );
  assert.equal(Model.latestMonth([]), "");
  assert.equal(Model.latestMonth(null), "");
});

test("openingMonth stays on this month when it has activity", () => {
  const ledger = {
    selectedMonth: "2026-06",
    transactions: [
      { date: "2026-08-04", amount: -10 },
      { date: "2026-06-01", amount: -5 },
    ],
  };
  assert.equal(Model.openingMonth(ledger, new Date(2026, 7, 15)), "2026-08");
});

test("openingMonth drops back to the last-open month when this month is empty", () => {
  // Last month's statements dropped in on the 15th; nothing in August yet.
  const ledger = {
    selectedMonth: "2026-06",
    transactions: [
      { date: "2026-06-01", amount: -5 },
      { date: "2026-07-20", amount: -8 },
    ],
  };
  assert.equal(Model.openingMonth(ledger, new Date(2026, 7, 15)), "2026-06");
});

test("openingMonth falls through to the newest month with data", () => {
  const ledger = {
    selectedMonth: "2026-01", // recorded, but that month has nothing
    transactions: [
      { date: "2026-05-01", amount: -5 },
      { date: "2026-07-20", amount: -8 },
    ],
  };
  assert.equal(Model.openingMonth(ledger, new Date(2026, 7, 15)), "2026-07");
});

test("openingMonth stays on this month for an empty or missing ledger", () => {
  assert.equal(Model.openingMonth({ transactions: [] }, new Date(2026, 7, 15)), "2026-08");
  assert.equal(Model.openingMonth(null, new Date(2026, 7, 15)), "2026-08");
});

test("the widget watches the server's revision file, wherever state lives", () => {
  assert.equal(
    Model.revisionFilePath("/run/state", "/home/user"),
    "/run/state/omakei/ledger-revision",
    "XDG_STATE_HOME wins when it is set",
  );
  assert.equal(
    Model.revisionFilePath("", "/home/user"),
    "/home/user/.local/state/omakei/ledger-revision",
    "and falls back to the default state directory",
  );
});
test("parseReaderOutput takes the reader's path and ledger apart", () => {
  const ledger = {
    version: 1,
    selectedMonth: "2026-08",
    transactions: [
      { date: "2026-08-02", amount: -4.5 },
      { date: "2026-08-03", amount: "not a number" },
    ],
  };
  const out = Model.parseReaderOutput(JSON.stringify({ path: "/s/omakei-ledger.json", ledger }));
  assert.equal(out.path, "/s/omakei-ledger.json");
  assert.equal(out.ledger.selectedMonth, "2026-08");
  assert.equal(out.ledger.transactions.length, 1, "rows without a usable amount are dropped");
});

test("parseReaderOutput keeps the path when there is no ledger there yet", () => {
  const out = Model.parseReaderOutput(JSON.stringify({ path: "/s/omakei-ledger.json", ledger: null }));
  assert.equal(out.path, "/s/omakei-ledger.json", "the empty state shows where it looked");
  assert.equal(out.ledger, null);
});

test("parseReaderOutput survives anything the reader could go wrong with", () => {
  const empty = { path: "", ledger: null, uncategorized: { merchants: [], total: 0 } };
  assert.deepEqual(Model.parseReaderOutput(""), empty);
  assert.deepEqual(Model.parseReaderOutput("null"), empty);
  assert.deepEqual(Model.parseReaderOutput("{trunca"), empty, "a half-written pipe must not throw");
  assert.deepEqual(Model.parseReaderOutput(JSON.stringify({ ledger: { version: 9 } })), empty);
});

test("parseReaderOutput carries the merchants that need a category", () => {
  const out = Model.parseReaderOutput(
    JSON.stringify({
      path: "/s/omakei-ledger.json",
      ledger: { version: 1, transactions: [{ date: "2026-08-02", amount: -4.5 }] },
      uncategorized: {
        merchants: [
          { merchant: "ZORP WIDGETS", count: 2, total: -42.5 },
          { merchant: "", count: 1, total: -1 },
          null,
        ],
        total: 9,
      },
    }),
  );
  assert.deepEqual(out.uncategorized.merchants, [{ merchant: "ZORP WIDGETS", count: 2, total: -42.5 }]);
  assert.equal(out.uncategorized.total, 9, "the count is what the ledger holds, not what fits");
});

test("parseUncategorized never reports fewer merchants than it hands over", () => {
  const out = Model.parseReaderOutput(
    JSON.stringify({
      uncategorized: { merchants: [{ merchant: "ZORP WIDGETS", count: 1, total: -1 }], total: "nonsense" },
    }),
  );
  assert.equal(out.uncategorized.total, 1, "a bad total falls back to the rows themselves");
});

test("categoryOptions offers the app's categories, placeholder first", () => {
  const options = Model.categoryOptions("Categorize…");
  assert.deepEqual(options[0], { value: "", label: "Categorize…" });
  assert.deepEqual(
    options.slice(1).map((o) => o.value),
    CATEGORIES.map((c) => c.id),
    "the popup must not offer an id omakei-categorize.mjs would reject",
  );
  assert.deepEqual(
    options.slice(1).map((o) => o.label),
    CATEGORIES.map((c) => c.name),
  );
  assert.equal(Model.categoryOptions()[0].value, "housing", "no placeholder unless one is asked for");
});

test("categorizeCommand runs the CLI, and nothing half-formed", () => {
  assert.deepEqual(Model.categorizeCommand("/p/omakei/", "ZORP WIDGETS", "shopping"), [
    "/p/omakei/scripts/omakei-categorize.mjs",
    "ZORP WIDGETS",
    "shopping",
  ]);
  assert.deepEqual(Model.categorizeCommand("", "ZORP WIDGETS", "shopping"), [], "no plugin dir");
  assert.deepEqual(Model.categorizeCommand("/p", "   ", "shopping"), [], "no merchant");
  assert.deepEqual(Model.categorizeCommand("/p", "ZORP", ""), [], "no category");
  assert.deepEqual(Model.categorizeCommand("/p", "ZORP", "nonsense"), [], "not a category");
  assert.deepEqual(
    Model.categorizeCommand("/p", "ZORP", "constructor"),
    [],
    "an inherited property is not a category",
  );
});

test("parseLedger still parses a raw ledger, unchanged", () => {
  const parsed = Model.parseLedger(
    JSON.stringify({ version: 1, selectedMonth: "2026-08", transactions: [{ date: "2026-08-02", amount: -1 }] }),
  );
  assert.equal(parsed.transactions.length, 1);
  assert.equal(Model.parseLedger("nonsense"), null);
});

test("daysInMonth spans the real month, leap year included", () => {
  assert.equal(Model.daysInMonth("2026-08"), 31);
  assert.equal(Model.daysInMonth("2026-09"), 30);
  assert.equal(Model.daysInMonth("2026-02"), 28);
  assert.equal(Model.daysInMonth("2024-02"), 29, "2024 is a leap year");
  assert.equal(Model.daysInMonth("nonsense"), 30, "an unparseable month must not throw");
});

test("dailySpend runs a month's spend up day by day", () => {
  const transactions = [
    { date: "2026-08-01", amount: -100 },
    { date: "2026-08-01", amount: -50 },
    { date: "2026-08-03", amount: -25 },
    { date: "2026-08-03", amount: 3000 }, // income is not spend
    { date: "2026-08-05", amount: -25, categoryId: "transfers" }, // nor is a transfer
    { date: "2026-07-31", amount: -900 }, // nor is another month
  ];
  const series = Model.dailySpend(transactions, "2026-08");

  assert.equal(series.days.length, 31, "every day of the month gets a point");
  assert.equal(series.total, 175);
  assert.equal(series.maxDaily, 150);
  assert.equal(series.days[0].spend, 150);
  assert.equal(series.days[0].cumulative, 150);
  assert.equal(series.days[1].spend, 0, "a day with nothing still gets a point");
  assert.equal(series.days[1].cumulative, 150, "and holds the running total flat");
  assert.equal(series.days[2].cumulative, 175);
  assert.equal(series.days[30].cumulative, 175, "the line runs to the end of the month");
});

test("dailySpend is safe on an empty or missing ledger", () => {
  const empty = Model.dailySpend(null, "2026-08");
  assert.equal(empty.days.length, 31);
  assert.equal(empty.total, 0);
  assert.equal(empty.maxDaily, 0);
  assert.equal(
    empty.days.every((d) => d.cumulative === 0),
    true,
  );
});

/**
 * The window arithmetic. One month back, clamped, then opened the day after,
 * so every day-of-month falls inside exactly once.
 */
test("trailingStart opens the day after the same date a month back", () => {
  assert.equal(Model.trailingStart("2026-09-09"), "2026-08-10");
  assert.equal(Model.trailingStart("2026-01-05"), "2025-12-06");
  // No Feb 30, so the clamp lands on Feb 28 and the window opens on Mar 1.
  assert.equal(Model.trailingStart("2026-03-30"), "2026-03-01");
  // A leap February holds the extra day, so the same end date in 2028 opens a
  // day earlier than it does in 2026.
  assert.equal(Model.trailingStart("2028-03-28"), "2028-02-29");
  assert.equal(Model.trailingStart("2026-03-28"), "2026-03-01");
  // Month end to month end stays a whole month.
  assert.equal(Model.trailingStart("2026-07-31"), "2026-07-01");
});

test("rollingSummary counts the month ending today, not the month so far", () => {
  const transactions = [
    // Last month's pay, inside the window.
    { date: "2026-08-14", amount: 4100, description: "Payroll", categoryId: "income" },
    { date: "2026-08-28", amount: 4100, description: "Payroll", categoryId: "income" },
    // Last month's mortgage, on the 1st, outside a window that opens the 10th.
    { date: "2026-08-01", amount: -2600, description: "Mortgage", categoryId: "housing" },
    // This month's big outs, inside.
    { date: "2026-09-01", amount: -2600, description: "Mortgage", categoryId: "housing" },
    { date: "2026-09-02", amount: -1800, description: "Day care", categoryId: "childcare" },
    { date: "2026-09-06", amount: -140.5, description: "Groceries", categoryId: "groceries" },
    // Transfers are neither in nor out, here as in the month figure.
    { date: "2026-09-03", amount: -900, description: "To savings", categoryId: "transfers" },
    // Tomorrow, and so outside a window that ends today.
    { date: "2026-09-10", amount: -60, description: "Gas", categoryId: "transport" },
  ];

  const rolling = Model.rollingSummary(transactions, [], "2026-09-09");
  assert.equal(rolling.start, "2026-08-10");
  assert.equal(rolling.end, "2026-09-09");
  assert.equal(rolling.label, "Aug 10 – Sep 9");
  assert.equal(rolling.income, 8200);
  assert.equal(rolling.spent, 4540.5);
  assert.equal(rolling.net, 3659.5);
  assert.ok(rolling.hasData);

  // The same ledger read as a calendar month is deep in the red, which is the
  // number this replaces. It also counts the whole month, tomorrow included.
  const month = Model.summarize(transactions, "2026-09", []);
  assert.equal(month.net, -4600.5);
});

test("rollingSummary subtracts the month's set-asides in full", () => {
  const transactions = [
    { date: "2026-08-14", amount: 3000, description: "Payroll", categoryId: "income" },
    { date: "2026-09-01", amount: -1000, description: "Mortgage", categoryId: "housing" },
  ];
  const rolling = Model.rollingSummary(
    transactions,
    [{ id: "tax", name: "Filing taxes", amount: 500 }],
    "2026-09-09",
  );
  assert.equal(rolling.allocated, 500);
  assert.equal(rolling.net, 1500);
});

/**
 * The guard that matters on a fresh install: a ledger holding only this
 * month's statement would report a month of income against a week of spend.
 */
test("rollingSummary is incomplete when the ledger stops inside the window", () => {
  const short = [{ date: "2026-09-02", amount: -1800, description: "Day care" }];
  assert.equal(Model.rollingSummary(short, [], "2026-09-09").complete, false);
  assert.equal(Model.rollingSummary([], [], "2026-09-09").complete, false);

  const reaching = [
    { date: "2026-08-10", amount: -20, description: "Coffee" },
    ...short,
  ];
  assert.equal(Model.rollingSummary(reaching, [], "2026-09-09").complete, true);
});

test("rollingSummary accepts a Date as well as a day string", () => {
  const rows = [{ date: "2026-09-05", amount: -25, description: "Coffee" }];
  const fromDate = Model.rollingSummary(rows, [], new Date(2026, 8, 9));
  assert.equal(fromDate.end, "2026-09-09");
  assert.equal(fromDate.start, "2026-08-10");
});

test("barTooltip names the window the bar number covers", () => {
  const rolling = {
    hasData: true,
    label: "Aug 10 – Sep 9",
    spent: 4540.5,
    income: 8200,
    allocated: 0,
  };
  assert.equal(Model.barTooltip(rolling), "Aug 10 – Sep 9  $4,541 spent  ·  $8,200 in");
  // A month summary names its month instead, and reserves show when set.
  assert.equal(
    Model.barTooltip({ ...rolling, monthLabel: "September 2026", label: "", allocated: 500 }),
    "September 2026  $4,541 spent  ·  $8,200 in  ·  $500 reserved",
  );
  assert.equal(Model.barTooltip({ hasData: false }), "Omakei ledger");
  assert.equal(Model.barTooltip(null), "Omakei ledger");
});

test("currentDay reads a Date in local time and passes a day string through", () => {
  assert.equal(Model.currentDay(new Date(2026, 8, 9)), "2026-09-09");
  assert.equal(Model.currentDay(new Date(2026, 0, 5)), "2026-01-05");
  assert.equal(Model.currentDay("2026-09-09"), "2026-09-09");
});
