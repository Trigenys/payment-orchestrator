import assert from "node:assert/strict";
import test from "node:test";
import { retryDisposition } from "../src/payments/types.js";

test("retryable provider failures retry the same logical operation", () => {
  assert.equal(retryDisposition({
    code: "network_error",
    provider: "provider-a",
    message: "timeout",
    retryable: true
  }), "retry_same_operation");
});

test("terminal provider failures must not be blindly retried", () => {
  assert.equal(retryDisposition({
    code: "provider_rejected",
    provider: "provider-a",
    message: "rejected",
    retryable: false
  }), "do_not_retry");
});
