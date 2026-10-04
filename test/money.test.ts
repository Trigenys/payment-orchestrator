import assert from "node:assert/strict";
import test from "node:test";
import { createMoney } from "../src/domain/money.js";

test("money accepts integer minor units and normalizes currency", () => {
  assert.deepEqual(createMoney(12_345, "xaf"), {
    amountMinor: 12_345,
    currency: "XAF"
  });
});

test("money rejects floating-point and unsafe minor units", () => {
  assert.throws(() => createMoney(10.5, "XAF"), /safe integer/i);
  assert.throws(() => createMoney(Number.MAX_SAFE_INTEGER + 1, "XAF"), /safe integer/i);
});

test("money rejects invalid currency codes", () => {
  assert.throws(() => createMoney(100, "FCFA"), /three-letter/i);
});
