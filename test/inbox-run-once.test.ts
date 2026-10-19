import assert from "node:assert/strict";
import test from "node:test";
import { runOnce } from "../src/worker/run-once.js";

test("private one-shot entrypoint refuses incomplete configuration before database access", async () => {
  const disabled = { PAYMENT_SANDBOX_SWEEP_ENABLED: "false" };
  await assert.rejects(runOnce(disabled), /disabled/);
  await assert.rejects(runOnce({ ...disabled, PAYMENT_SANDBOX_SWEEP_ENABLED: "true" }), /PAYMENT_SANDBOX_PROJECT_ID/);
});
