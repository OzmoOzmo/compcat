import test from "node:test";
import assert from "node:assert/strict";
import { detectComponentBounds, normalizeMarking } from "../vision.js";

function makeImage(width, height, rectangles, background = 250) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      const level = Math.max(220, background - Math.floor((x / width) * 12));
      data[index] = level;
      data[index + 1] = level;
      data[index + 2] = level;
      data[index + 3] = 255;
    }
  }
  for (const rectangle of rectangles) {
    for (let y = rectangle.y; y < rectangle.y + rectangle.height; y += 1) {
      for (let x = rectangle.x; x < rectangle.x + rectangle.width; x += 1) {
        const index = (y * width + x) * 4;
        data[index] = rectangle.color ?? 35;
        data[index + 1] = rectangle.color ?? 35;
        data[index + 2] = rectangle.color ?? 35;
      }
    }
  }
  return data;
}

test("finds separate component-sized objects on a mildly uneven light background", () => {
  const data = makeImage(320, 240, [
    { x: 34, y: 58, width: 62, height: 34 },
    { x: 185, y: 132, width: 79, height: 42, color: 62 }
  ]);
  const result = detectComponentBounds(data, 320, 240);
  assert.equal(result.regions.length, 2);
  assert.deepEqual(
    result.regions.map(({ x, y, width, height }) => ({ x, y, width, height })),
    [
      { x: 34, y: 58, width: 62, height: 34 },
      { x: 185, y: 132, width: 79, height: 42 }
    ]
  );
});

test("returns no regions for an empty light scene", () => {
  const result = detectComponentBounds(makeImage(240, 180, []), 240, 180);
  assert.deepEqual(result.regions, []);
});

test("normalizes markings for matching without confusing punctuation or case", () => {
  assert.equal(normalizeMarking("  sn74-LS00N \n"), "SN74LS00N");
  assert.equal(normalizeMarking(""), "");
});

test("rejects malformed image data", () => {
  assert.throws(() => detectComponentBounds(new Uint8Array(4), 20, 20), TypeError);
});
