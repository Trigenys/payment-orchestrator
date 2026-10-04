import assert from "node:assert/strict";
import test from "node:test";
import {
  decidePaymentTransition,
  isTerminalPaymentStatus
} from "../src/payments/state-machine.js";

test("allowed forward transitions apply", () => {
  assert.deepEqual(decidePaymentTransition("created", "pending"), { outcome: "apply" });
  assert.deepEqual(decidePaymentTransition("pending", "succeeded"), { outcome: "apply" });
  assert.deepEqual(decidePaymentTransition("succeeded", "refunded"), { outcome: "apply" });
});

test("same state is a duplicate, not a second transition", () => {
  const decision = decidePaymentTransition("succeeded", "succeeded");
  assert.equal(decision.outcome, "ignore_duplicate");
});

test("late earlier states are explicitly ignored as stale", () => {
  const decision = decidePaymentTransition("succeeded", "pending");
  assert.equal(decision.outcome, "ignore_stale");
});

test("contradictory terminal transitions are explicitly rejected", () => {
  const decision = decidePaymentTransition("failed", "succeeded");
  assert.equal(decision.outcome, "reject");
  assert.match(decision.reason, /not allowed/i);
});

test("terminal statuses are explicit", () => {
  assert.equal(isTerminalPaymentStatus("failed"), true);
  assert.equal(isTerminalPaymentStatus("cancelled"), true);
  assert.equal(isTerminalPaymentStatus("refunded"), true);
  assert.equal(isTerminalPaymentStatus("succeeded"), false);
});
