import assert from "node:assert/strict";
import { test } from "node:test";
import {
  availableNet,
  parseMoneyInput,
  parseSetAsides,
  setAsideTotal,
} from "./set-asides.ts";

test("parseSetAsides keeps valid rows and drops junk", () => {
  assert.deepEqual(parseSetAsides(undefined), []);
  assert.deepEqual(parseSetAsides(null), []);
  assert.deepEqual(
    parseSetAsides([
      { id: "a", name: "Safety Net", amount: 1000 },
      { id: "b", name: "Filing taxes", amount: 500.555 },
      { name: "no id", amount: 1 },
      { id: "c", amount: "nope" },
      { id: "", name: "empty id", amount: 1 },
    ]),
    [
      { id: "a", name: "Safety Net", amount: 1000 },
      { id: "b", name: "Filing taxes", amount: 500.56 },
      { id: "c", name: "", amount: 0 },
    ],
  );
});

test("availableNet subtracts this month's reserved amount from this month's cashflow", () => {
  const taxes = [{ id: "b", name: "Filing taxes", amount: 500 }];
  assert.equal(setAsideTotal(taxes), 500);
  assert.equal(availableNet(2300, taxes), 1800);
  assert.equal(availableNet(-100, taxes), -600);
});

test("parseMoneyInput accepts currency typing", () => {
  assert.equal(parseMoneyInput(""), 0);
  assert.equal(parseMoneyInput("1000"), 1000);
  assert.equal(parseMoneyInput("$1,000.00"), 1000);
  assert.equal(parseMoneyInput("500.5"), 500.5);
  assert.equal(parseMoneyInput("−200"), 200);
  assert.equal(parseMoneyInput("abc"), null);
});
