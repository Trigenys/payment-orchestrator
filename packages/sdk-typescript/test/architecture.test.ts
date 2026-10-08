import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("SDK transport contains no PSP-specific implementation", () => {
  const source = [
    fs.readFileSync("src/client.ts", "utf8"),
    fs.readFileSync("src/errors.ts", "utf8"),
    fs.readFileSync("src/idempotency.ts", "utf8")
  ].join("\n");

  for (const forbidden of [
    /flutterwave/i,
    /cinetpay/i,
    /notch\s*pay/i,
    /paystack/i,
    /subaccount/i,
    /verif-hash/i
  ]) {
    assert.doesNotMatch(source, forbidden);
  }
});

test("SDK package never accepts provider secret-key configuration", () => {
  const source = fs.readFileSync("src/client.ts", "utf8");

  assert.doesNotMatch(source, /providerSecret/i);
  assert.doesNotMatch(source, /secretKey/i);
  assert.match(source, /apiKey/);
});
