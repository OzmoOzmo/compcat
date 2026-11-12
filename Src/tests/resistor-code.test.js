import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { decodeResistorBands, formatResistorValue } from "../resistor-code.js";

async function loadLabeledExamples() {
  const csv = await readFile(new URL("./IPhoneTests/resistor-labels.csv", import.meta.url), "utf8");
  return csv.trim().split(/\r?\n/).slice(1).map((line) => {
    const [image, example, bands, ohms, tolerance, split] = line.split(",");
    return {
      image,
      example,
      bands: bands.split("-"),
      ohms: Number(ohms),
      tolerance: Number(tolerance),
      split
    };
  });
}

test("decodes every labeled resistor example using the standard color code", async () => {
  const examples = await loadLabeledExamples();
  assert.equal(examples.length, 18);

  for (const example of examples) {
    assert.deepEqual(decodeResistorBands(example.bands), {
      ohms: example.ohms,
      tolerancePercent: example.tolerance
    }, `${example.image}: ${example.example}`);
  }
});

test("formats resistor values using the appropriate SI prefix", () => {
  assert.equal(formatResistorValue({ ohms: 39_000, tolerancePercent: 5 }), "39 kΩ ±5%");
  assert.equal(formatResistorValue({ ohms: 47, tolerancePercent: 5 }), "47 Ω ±5%");
  assert.equal(formatResistorValue({ ohms: 1_500, tolerancePercent: 5 }), "1.5 kΩ ±5%");
});

test("rejects unsupported bands rather than guessing a value", () => {
  assert.throws(() => decodeResistorBands(["orange", "white", "orange", "orange"]), /tolerance/);
  assert.throws(() => decodeResistorBands(["gold", "red", "orange", "gold"]), /Significant-digit/);
  assert.throws(() => decodeResistorBands(["brown", "black", "yellow"]), /four or five/);
});
