/**
 * The page carries the ledger inline. Merchant names are bank text that any
 * merchant chooses, so nothing in them may change the page around the payload.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { injectState } from "./page-shell.mjs";

const HTML = `<html lang="en"><head><!--omakei:state--></head><body><script type="module" src="/a.js"></script></body></html>`;

function payloadOf(html) {
  const match = html.match(/<script>window\.__OMAKEI_STATE=(.*?)<\/script>/s);
  assert.ok(match, "the state script is there");
  return JSON.parse(match[1]);
}

test("replacement patterns in a description are data, not instructions", () => {
  for (const description of [
    "$'",
    "$`",
    "$&",
    "$$",
    "PAY $' ME </script><script>alert(1)</script>",
  ]) {
    const state = { ledger: { transactions: [{ description }] } };
    const html = injectState(HTML, state);
    assert.equal(payloadOf(html).ledger.transactions[0].description, description, description);
    assert.equal(html.match(/<script/g).length, 2, `${description}: no extra script element`);
    assert.ok(html.endsWith("</body></html>"), "the page after the payload is untouched");
  }
});

test("a subscription mark key is just as inert", () => {
  const key = "x</script><img src=x onerror=alert(1)>$'";
  const html = injectState(HTML, {
    ledger: { subscriptionMarks: [{ key, kind: "not-subscription", ref: "" }] },
  });
  assert.equal(payloadOf(html).ledger.subscriptionMarks[0].key, key);
  assert.doesNotMatch(html, /<img/);
});
