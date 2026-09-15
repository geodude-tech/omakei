import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assignCategory,
  isGenericMerchant,
  pinCategory,
  refreshCategories,
  uncategorizedIdsFor,
  seedRules,
  upsertRule,
} from "./ledger.ts";
import type { CategorizeRule, Transaction } from "./types.ts";

/** The default patterns, as they ship in the build. */
function defaults(): CategorizeRule[] {
  return seedRules();
}

function userRule(
  pattern: string,
  categoryId: string,
  createdAt = Date.now(),
): CategorizeRule {
  return { id: `u:${pattern}`, pattern, categoryId, createdAt, source: "user" };
}

function tx(
  partial: Partial<Transaction> &
    Pick<Transaction, "id" | "description" | "amount">,
): Transaction {
  return {
    date: "2026-08-10",
    accountName: "checking",
    accountKind: "checking",
    sourceFile: "test.csv",
    fingerprint: `fp:${partial.id}`,
    categoryId: null,
    importedAt: 0,
    ...partial,
  };
}

/* ------------------------------------------------------------ assignCategory */

test("assignCategory: a user rule beats a matching default", () => {
  // "starbucks" is a default → coffee.
  const rules = [userRule("starbucks", "groceries"), ...defaults()];
  assert.equal(assignCategory("STARBUCKS STORE 01234", rules), "groceries");
  assert.equal(assignCategory("STARBUCKS STORE 01234", defaults()), "coffee");
});

test("assignCategory: a structural transfer beats a default", () => {
  // Description matches nothing in the defaults; the transfer rule tags it.
  assert.equal(
    assignCategory("ONLINE TRANSFER TO SAV 1234", defaults(), "checking"),
    "transfers",
  );
});

test("assignCategory: a mortgage-account payment is Housing, ahead of defaults", () => {
  assert.equal(
    assignCategory("Regular Payment", defaults(), "mortgage"),
    "housing",
  );
});

test("assignCategory: no rule matches → null (never coerced to other)", () => {
  assert.equal(assignCategory("ZORP WIDGETS LLC 9981", defaults()), null);
  assert.equal(assignCategory("ZORP WIDGETS LLC 9981", []), null);
});

test("assignCategory: a default still resolves with no accountKind or amount", () => {
  assert.equal(assignCategory("NETFLIX.COM", defaults()), "subscriptions");
});

test("assignCategory: the longest matching identifier wins", () => {
  // Both "safeway" (groceries) and "safeway fuel" (transport) ship as defaults.
  assert.equal(
    assignCategory("SAFEWAY FUEL 55 SPRINGFIELD IL", defaults()),
    "transport",
  );
  assert.equal(assignCategory("SAFEWAY 0421 SPRINGFIELD IL", defaults()), "groceries");
});

test("assignCategory: same-length identifiers → the newer user rule wins", () => {
  // "walmart" and "wal mart" both reduce to the 7-char identifier "walmart"
  // and both match "WALMART SUPERCENTER".
  const older = userRule("walmart", "groceries", 100);
  const newer = userRule("wal mart", "shopping", 200);
  assert.equal(
    assignCategory("WALMART SUPERCENTER 22", [older, newer]),
    "shopping",
  );
  assert.equal(
    assignCategory("WALMART SUPERCENTER 22", [
      { ...older, createdAt: 300 },
      newer,
    ]),
    "groceries",
  );
});

test("assignCategory: the default pass never returns a user rule and vice versa", () => {
  // Only a user rule present, no defaults: still resolves.
  assert.equal(assignCategory("NETFLIX.COM", [userRule("netflix", "entertainment")]), "entertainment");
  // Only defaults present: the user-rule category ("entertainment") is unreachable.
  assert.equal(assignCategory("NETFLIX.COM", defaults()), "subscriptions");
});

/* --------------------------------------------------------------- upsertRule */

test("upsertRule: re-assigning the same pattern updates in place, adds no row", () => {
  const once = upsertRule([], "Costco", "groceries");
  assert.equal(once.length, 1);
  assert.equal(once[0]!.categoryId, "groceries");

  const twice = upsertRule(once, "costco", "shopping");
  assert.equal(twice.length, 1);
  assert.equal(twice[0]!.categoryId, "shopping");
  assert.equal(twice[0]!.id, once[0]!.id);
});

test("upsertRule: a new pattern is prepended as a user rule", () => {
  const start = [userRule("costco", "groceries", 1)];
  const next = upsertRule(start, "Target", "shopping");
  assert.equal(next.length, 2);
  assert.equal(next[0]!.pattern, "Target");
  assert.equal(next[0]!.source, "user");
  assert.ok(next[0]!.createdAt > 0);
  assert.equal(next[1], start[0]);
});

test("upsertRule: patterns that only differ by whitespace are distinct rules", () => {
  const start = upsertRule([], "cost co", "groceries");
  const next = upsertRule(start, "costco", "shopping");
  assert.equal(next.length, 2);
});

/* ---------------------------------------------------------- refreshCategories */

test("refreshCategories: an unmatched row stays null", () => {
  const rows = [tx({ id: "1", description: "ZORP WIDGETS 5567", amount: -12.5 })];
  const out = refreshCategories(rows, defaults());
  assert.equal(out[0]!.categoryId, null);
});

test("refreshCategories: adding a rule re-tags history; removing it reverts", () => {
  const rows = [
    tx({ id: "1", description: "ZORP WIDGETS 5567", amount: -12.5 }),
    tx({ id: "2", description: "ZORP WIDGETS 1180", amount: -30 }),
    tx({ id: "3", description: "NETFLIX.COM", amount: -15.99 }),
  ];

  const tagged = refreshCategories(rows, [
    userRule("zorp widgets", "shopping"),
    ...defaults(),
  ]);
  assert.deepEqual(
    tagged.map((t) => [t.id, t.categoryId]),
    [
      ["1", "shopping"],
      ["2", "shopping"],
      ["3", "subscriptions"],
    ],
  );

  const reverted = refreshCategories(tagged, defaults());
  assert.deepEqual(
    reverted.map((t) => [t.id, t.categoryId]),
    [
      ["1", null],
      ["2", null],
      ["3", "subscriptions"],
    ],
  );
});

test("refreshCategories: running twice on derived rows changes nothing", () => {
  const rows = [
    tx({ id: "1", description: "STARBUCKS STORE 01234", amount: -6.25 }),
    tx({ id: "2", description: "ZORP WIDGETS 5567", amount: -12.5 }),
    tx({ id: "3", description: "WHOLE FOODS MKT 104", amount: -84.1 }),
  ];
  const once = refreshCategories(rows, defaults());
  const twice = refreshCategories(once, defaults());
  assert.deepEqual(
    twice.map((t) => t.categoryId),
    once.map((t) => t.categoryId),
  );
});

/* ------------------------------------------------------------ pinned checks */

test("refreshCategories: a pin survives re-derive and beats a matching rule", () => {
  const rows = [
    tx({ id: "p", description: "ZORP WIDGETS 5567", amount: -12, pinnedCategoryId: "childcare" }),
  ];
  const out = refreshCategories(rows, [userRule("zorp widgets", "shopping"), ...defaults()]);
  assert.equal(out[0]!.categoryId, "childcare");
  assert.equal(refreshCategories(out, defaults())[0]!.categoryId, "childcare");
});

test("a rule never categorizes a check, however it got into the ledger", () => {
  const rules = [userRule("check", "childcare"), userRule("/.*/", "shopping"), ...defaults()];
  for (const description of ["CHECK", "Check 1042", "CHECK #1042", "CHK 88"]) {
    assert.equal(assignCategory(description, rules, "checking", -2500), null, description);
  }
  // The same rules still apply to anything that is not a bare check.
  assert.equal(assignCategory("QQQ UNKNOWN VENDOR 90", rules, "checking", -9), "shopping");
});

test("pinCategory: pins only the named rows; a new check after it stays uncategorized", () => {
  const rows = [
    tx({ id: "c1", description: "CHECK", amount: -2380.26 }),
    tx({ id: "c2", description: "CHECK", amount: -2496.62, date: "2026-07-27" }),
    tx({ id: "x", description: "QQQ UNKNOWN VENDOR 90", amount: -5 }),
  ];
  const ids = uncategorizedIdsFor(rows, "CHECK");
  assert.deepEqual([...ids].sort(), ["c1", "c2"]);

  const pinned = refreshCategories(pinCategory(rows, ids, "childcare"), defaults());
  const next = refreshCategories(
    [...pinned, tx({ id: "c3", description: "CHECK", amount: -3144.13, date: "2026-09-03" })],
    defaults(),
  );
  const byId = Object.fromEntries(next.map((t) => [t.id, t.categoryId]));
  assert.deepEqual(byId, { c1: "childcare", c2: "childcare", x: null, c3: null });
  assert.deepEqual([...uncategorizedIdsFor(next, "CHECK")], ["c3"]);
});

test("transfer pairing leaves a pinned check alone", () => {
  const rows = [
    tx({
      id: "chk",
      description: "CHECK",
      amount: -2599.93,
      date: "2026-06-05",
      pinnedCategoryId: "childcare",
    }),
    tx({ id: "mtg", description: "Mail", amount: -2599.93, date: "2026-06-04", accountKind: "mortgage" }),
  ];
  const byId = Object.fromEntries(
    refreshCategories(rows, defaults()).map((t) => [t.id, t.categoryId]),
  );
  assert.equal(byId.chk, "childcare");
  assert.equal(byId.mtg, "housing");

  // Unpinned, the same check pairs with the mortgage payment as before.
  const unpinned = rows.map((t) => ({ ...t, pinnedCategoryId: undefined }));
  assert.equal(refreshCategories(unpinned, defaults())[0]!.categoryId, "transfers");
});

test("isGenericMerchant: checks only", () => {
  assert.equal(isGenericMerchant("CHECK"), true);
  assert.equal(isGenericMerchant("check 1042"), true);
  assert.equal(isGenericMerchant("CHECKERS"), false);
  assert.equal(isGenericMerchant("SAFEWAY"), false);
});
