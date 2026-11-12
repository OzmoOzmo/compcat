import test from "node:test";
import assert from "node:assert/strict";
import { correctLikelyDigitConfusions } from "../ocr/browser-ocr.js";

test("corrects common zero and five OCR confusions in mixed part markings", () => {
  assert.equal(
    correctLikelyDigitConfusions("SN74HC1ON\nTLCS55IP\n58ON-8"),
    "SN74HC10N\nTLC555IP\n580N-8"
  );
});

test("leaves words, letters, and short mixed tokens unchanged", () => {
  assert.equal(
    correctLikelyDigitConfusions("SOLDER\nSN74LS00N\nA0S"),
    "SOLDER\nSN74LS00N\nA0S"
  );
});
