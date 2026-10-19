import assert from "node:assert/strict";
import test from "node:test";
import { FapshiInboxWorker } from "../src/worker/fapshi-inbox-worker.js";
import type { InboxLease, PostgresInboxWorkerStore } from "../src/worker/inbox-persistence.js";

type Store = Pick<PostgresInboxWorkerStore,
  "claim" | "complete" | "retry" | "deferRateLimit" | "findBoundPayment">;

function fixture(status: InboxLease["status"] = "SUCCESSFUL") {
  const lease: InboxLease = {
    id: "inbox-1", providerReference: "trans-1", status,
    attemptCount: 1, leaseToken: "claim-1"
  };
  const called = { checked: 0, reserved: 0, confirmed: 0, completed: 0, retried: 0, deferred: 0 };
  let payment: string | undefined = "payment-1";
  let allowed = true;
  let failConfirmation = false;
  const store: Store = {
    claim: async () => [lease],
    complete: async () => { called.completed++; return true; },
    retry: async () => { called.retried++; return "retry_scheduled"; },
    deferRateLimit: async () => { called.deferred++; return true; },
    findBoundPayment: async () => { called.checked++; return payment; }
  };
  const worker = new FapshiInboxWorker({
    projectId: "project-test", merchantId: "merchant-test",
    store,
    reserveStatusRead: async ref => {
      assert.equal(ref, "trans-1");
      called.reserved++;
      return allowed;
    },
    confirmation: {
      confirm: async paymentId => {
        assert.equal(paymentId, "payment-1");
        called.confirmed++;
        if (failConfirmation) throw new Error("PSP temporarily unavailable");
        return {
          paymentId, ledgerBatchId: "batch", outboxId: "message", replayed: false
        };
      }
    }
  });
  return {
    worker, called,
    missingBinding: () => { payment = undefined; },
    exhaustedQuota: () => { allowed = false; },
    confirmationFails: () => { failConfirmation = true; }
  };
}

test("SUCCESSFUL inbox evidence independently verifies before processing", async () => {
  const f = fixture();
  assert.deepEqual(await f.worker.runBatch(), {
    claimed: 1, processed: 1, deferred: 0, retryScheduled: 0,
    quarantined: 0, stale: 0
  });
  assert.deepEqual(f.called, {
    checked: 1, reserved: 1, confirmed: 1,
    completed: 1, retried: 0, deferred: 0
  });
});

test("FAILED and EXPIRED webhooks record observations, never trigger financial changes", async () => {
  for (const status of ["FAILED", "EXPIRED"] as const) {
    const f = fixture(status);
    const result = await f.worker.runBatch();
    assert.equal(result.processed, 1);
    assert.equal(f.called.checked, 0);
    assert.equal(f.called.reserved, 0);
    assert.equal(f.called.confirmed, 0);
  }
});

test("unbound reference, budget denial, and PSP errors schedule safe retries", async () => {
  const missing = fixture();
  missing.missingBinding();
  assert.equal((await missing.worker.runBatch()).retryScheduled, 1);
  assert.equal(missing.called.reserved, 0);

  const quota = fixture();
  quota.exhaustedQuota();
  assert.equal((await quota.worker.runBatch()).deferred, 1);
  assert.equal(quota.called.confirmed, 0);
  assert.equal(quota.called.deferred, 1);

  const fails = fixture();
  fails.confirmationFails();
  assert.equal((await fails.worker.runBatch()).retryScheduled, 1);
  assert.equal(fails.called.confirmed, 1);
  assert.equal(fails.called.completed, 0);
});
