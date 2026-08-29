/**
 * Registry smoke test, promised by `docs/spec/panel-contract.md`: every
 * discovered module must export a function default and a `meta` with a
 * non-empty `title` and a `span` in 1-5, or it is dropped rather than crashing
 * the dashboard.
 *
 * This exercises `readPanel`/`isPanelMeta` directly against synthetic module
 * objects rather than the real `src/panels/*.tsx` files: those are `.tsx`, and
 * `node --experimental-strip-types` cannot strip JSX, so the test runner
 * cannot load them (see the panel contract's Testing Strategy). Real panels
 * are checked statically by `scripts/check-panels.mjs` instead; this test
 * covers the runtime validation logic those files run through in the browser.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isPanelMeta, readPanel } from "../panels/validate.ts";

function Placeholder() {
  return null;
}

test("readPanel accepts a well-formed module", () => {
  const panel = readPanel("restaurant-trend", {
    default: Placeholder,
    meta: { title: "Restaurants", span: 2, order: 40 },
  });
  assert.ok(panel);
  assert.equal(panel.id, "restaurant-trend");
  assert.equal(panel.title, "Restaurants");
  assert.equal(panel.span, 2);
  assert.equal(panel.order, 40);
  assert.equal(panel.Component, Placeholder);
});

test("readPanel fills in the default span and order", () => {
  const panel = readPanel("minimal", { default: Placeholder, meta: { title: "Minimal" } });
  assert.ok(panel);
  assert.equal(panel.span, 2);
  assert.equal(panel.order, 100);
});

test("readPanel drops a module with no default export", (t) => {
  t.mock.method(console, "warn", () => {});
  const panel = readPanel("broken", { meta: { title: "Broken" } });
  assert.equal(panel, null);
});

test("readPanel drops a module with no meta export", (t) => {
  t.mock.method(console, "warn", () => {});
  const panel = readPanel("broken", { default: Placeholder });
  assert.equal(panel, null);
});

test("isPanelMeta rejects an empty or whitespace-only title", () => {
  assert.equal(isPanelMeta({ title: "" }), false);
  assert.equal(isPanelMeta({ title: "   " }), false);
  assert.equal(isPanelMeta({ title: "Restaurants" }), true);
});

test("isPanelMeta rejects a span outside 1-5", () => {
  assert.equal(isPanelMeta({ title: "Restaurants", span: 0 }), false);
  assert.equal(isPanelMeta({ title: "Restaurants", span: 6 }), false);
  assert.equal(isPanelMeta({ title: "Restaurants", span: 3 }), true);
});

test("isPanelMeta rejects a non-finite order", () => {
  assert.equal(isPanelMeta({ title: "Restaurants", order: NaN }), false);
  assert.equal(isPanelMeta({ title: "Restaurants", order: 40 }), true);
});
