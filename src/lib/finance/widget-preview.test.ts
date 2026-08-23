import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildWidgetPreviewSearch,
  parseWidgetPreviewSearch,
} from "./widget-preview.ts";

const SAMPLE = {
  month: "2026-08",
  spent: 4312.55,
  income: 8200,
  net: 3387.45,
  uncategorized: 17,
  allocated: 500,
  setAsides: [{ id: "tax", name: "Filing taxes", amount: 500 }],
};

test("widget preview search round-trips cell values and set-asides", () => {
  const search = buildWidgetPreviewSearch(SAMPLE);
  assert.equal(
    search,
    "m=2026-08&sp=4312.55&inc=8200&n=3387.45&u=17&r=500&sa=tax%09Filing%20taxes%09500",
  );
  assert.deepEqual(parseWidgetPreviewSearch(`?${search}`), SAMPLE);
  assert.deepEqual(parseWidgetPreviewSearch(search), SAMPLE);
});

test("widget preview parse rejects incomplete or invalid queries", () => {
  assert.equal(parseWidgetPreviewSearch(""), null);
  assert.equal(parseWidgetPreviewSearch("sp=1&inc=2&n=3"), null);
  assert.equal(parseWidgetPreviewSearch("m=08-2026&sp=1&inc=2&n=3"), null);
  assert.equal(parseWidgetPreviewSearch("m=2026-08&sp=nope&inc=2&n=3"), null);
});

test("widget preview omits reserved when nothing is set aside", () => {
  const search = buildWidgetPreviewSearch({
    ...SAMPLE,
    allocated: 0,
    setAsides: [],
  });
  assert.equal(search.includes("&r="), false);
  assert.equal(search.includes("&sa="), false);
  assert.deepEqual(parseWidgetPreviewSearch(search), {
    ...SAMPLE,
    allocated: 0,
    setAsides: [],
  });
});
