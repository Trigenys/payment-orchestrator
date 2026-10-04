import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("payment state core contains no PSP-specific status or field vocabulary", () => {
  const files = [
    "src/payments/types.ts",
    "src/payments/state-machine.ts",
    "src/payments/persistence.ts",
    "src/payments/service.ts"
  ];

  const forbidden = [
    /flutterwave/i,
    /cinetpay/i,
    /notch\s*pay/i,
    /paystack/i,
    /subaccount/i
  ];

  for (const path of files) {
    const source = fs.readFileSync(path, "utf8");
    for (const pattern of forbidden) {
      assert.doesNotMatch(source, pattern, `${path} leaked provider-specific vocabulary`);
    }
  }
});
