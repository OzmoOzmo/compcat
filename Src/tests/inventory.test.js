import test from "node:test";
import assert from "node:assert/strict";
import {
  buildMarkdown,
  duplicateSuggestions,
  filterInventory,
  paginate,
  suspectedBad
} from "../inventory.js";

test("highlights existing and repeated batch markings without removing them", () => {
  const candidates = [
    { id: "one", name: "SN74LS00N" },
    { id: "two", name: "sn74-ls00n" },
    { id: "three", name: "LM358" }
  ];
  const inventory = [{ normalizedName: "SN74LS00N" }];
  const suggestions = duplicateSuggestions(candidates, inventory);
  assert.match(suggestions.get("one"), /already/);
  assert.match(suggestions.get("two"), /already/);
  assert.equal(suggestions.has("three"), false);
  assert.equal(candidates.length, 3);
});

test("highlights every member of a repeated in-batch marking", () => {
  const suggestions = duplicateSuggestions([
    { id: "first", name: "CD4026BE" },
    { id: "second", name: "cd-4026be" }
  ], []);
  assert.match(suggestions.get("first"), /more than once/);
  assert.match(suggestions.get("second"), /more than once/);
});

test("exports an inventory in the sample Markdown shape with captured quantities", () => {
  const markdown = buildMarkdown([
    { id: 2, name: "SN74LS00N", description: "Quad NAND | TTL", itemCount: 3 },
    { id: 1, name: "LM358", description: "Dual op amp", itemCount: 1 }
  ]);
  assert.match(markdown, /^# Components\n\n2 components\.\n/m);
  assert.match(markdown, /\| ID \| Name \| Description \| Items \|/);
  assert.match(markdown, /\| 1 \| LM358 \| Dual op amp \| 1 \|/);
  assert.match(markdown, /\| 2 \| SN74LS00N \| Quad NAND \\| TTL \| 3 \|/);
});

test("history search matches case-insensitive substrings across component and captured-item fields", () => {
  const components = [
    { name: "SN74LS00N", description: "Quad NAND", items: [{ marking: "74LS00" }] },
    { name: "LM358", manufacturer: "Texas Instruments", items: [{ marking: "358P" }] }
  ];
  assert.deepEqual(filterInventory(components, "quad"), [components[0]]);
  assert.deepEqual(filterInventory(components, "texas"), [components[1]]);
  assert.deepEqual(filterInventory(components, "74ls00"), [components[0]]);
  assert.equal(filterInventory(components, "missing").length, 0);
});

test("history pagination clamps page bounds and reports the visible range", () => {
  const components = Array.from({ length: 121 }, (_, index) => ({ id: index + 1 }));
  const page = paginate(components, 99, 50);
  assert.equal(page.page, 3);
  assert.equal(page.pageCount, 3);
  assert.equal(page.start, 100);
  assert.equal(page.end, 121);
  assert.equal(page.items.length, 21);
  assert.equal(paginate([], 1, 50).pageCount, 1);
});

test("flags empty or low-confidence markings for review", () => {
  assert.equal(suspectedBad({ marking: "", confidence: 0.99 }), true);
  assert.equal(suspectedBad({ marking: "LM358", confidence: 0.54 }), true);
  assert.equal(suspectedBad({ marking: "LM358", confidence: 0.55 }), false);
});
