import assert from "node:assert/strict";
import test from "node:test";
import { createMoney } from "../src/domain/money.js";
import type { Payment, Settlement } from "../src/domain/models.js";
import { InMemoryLedgerPersistence } from "../src/ledger/persistence.js";
import { LedgerService } from "../src/ledger/service.js";
import { InMemoryReconciliationPersistence } from "../src/reconciliation/persistence.js";
import { ReconciliationService } from "../src/reconciliation/service.js";

function fixture() {
  let id = 0;
  let tick = 0;

  const ledgerPersistence = new InMemoryLedgerPersistence();
  const reconciliationPersistence = new InMemoryReconciliationPersistence();

  const ledger = new LedgerService({
    persistence: ledgerPersistence,
    newId: () => `ledger-${++id}`,
    now: () => new Date(Date.UTC(2026, 9, 5, 8, 0, tick++)).toISOString()
  });

  const reconciliation = new ReconciliationService({
    ledgerPersistence,
    persistence: reconciliationPersistence,
    newId: () => `recon-${++id}`,
    now: () => new Date(Date.UTC(2026, 9, 5, 9, 0, tick++)).toISOString()
  });

  return { ledger, reconciliation };
}

function payment(status: Payment["status"] = "succeeded"): Payment {
  return {
    id: "payment-1",
    projectId: "project-zamari",
    merchantId: "merchant-centre-a",
    amount: createMoney(50_000, "XAF"),
    status,
    externalReference: "zamari-payment-1",
    provider: "provider-a",
    providerEnvironment: "sandbox",
    providerReference: "provider-payment-1",
    version: 3,
    createdAt: "2026-10-05T07:00:00.000Z",
    updatedAt: "2026-10-05T07:05:00.000Z"
  };
}

test("matching payment reconciliation is replay-safe", async () => {
  const { ledger, reconciliation } = fixture();

  await ledger.recordPaymentBreakdown({
    projectId: "project-zamari",
    merchantId: "merchant-centre-a",
    paymentId: "payment-1",
    sourceKey: "payment:payment-1:verified:v1",
    gross: createMoney(50_000, "XAF"),
    providerFee: createMoney(1_000, "XAF"),
    merchantShare: createMoney(47_500, "XAF"),
    platformCommission: createMoney(1_500, "XAF"),
    provider: "provider-a",
    providerReference: "provider-payment-1",
    occurredAt: "2026-10-05T07:05:00.000Z"
  });

  const input = {
    projectId: "project-zamari",
    merchantId: "merchant-centre-a",
    provider: "provider-a",
    payment: payment(),
    authoritative: {
      externalReference: "zamari-payment-1",
      providerReference: "provider-payment-1",
      status: "succeeded" as const,
      amount: createMoney(50_000, "XAF"),
      verifiedAt: "2026-10-05T07:06:00.000Z"
    },
    financials: {
      providerFee: createMoney(1_000, "XAF"),
      merchantShare: createMoney(47_500, "XAF"),
      platformCommission: createMoney(1_500, "XAF")
    },
    expectedProviderReference: "provider-payment-1"
  };

  const first = await reconciliation.reconcilePayment(input);
  const replay = await reconciliation.reconcilePayment(input);

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (!first.ok || !replay.ok) return;

  assert.equal(first.value.run.status, "matched");
  assert.equal(first.value.run.discrepancies.length, 0);
  assert.equal(first.value.replayed, false);
  assert.equal(replay.value.replayed, true);
  assert.equal(first.value.run.id, replay.value.run.id);
});

test("payment reconciliation exposes explicit financial discrepancies", async () => {
  const { ledger, reconciliation } = fixture();

  await ledger.recordPaymentBreakdown({
    projectId: "project-zamari",
    merchantId: "merchant-centre-a",
    paymentId: "payment-1",
    sourceKey: "payment:payment-1:verified:v1",
    gross: createMoney(50_000, "XAF"),
    merchantShare: createMoney(48_000, "XAF"),
    provider: "provider-a",
    providerReference: "provider-payment-1",
    occurredAt: "2026-10-05T07:05:00.000Z"
  });

  const result = await reconciliation.reconcilePayment({
    projectId: "project-zamari",
    merchantId: "merchant-centre-a",
    provider: "provider-a",
    payment: payment("pending"),
    authoritative: {
      externalReference: "zamari-payment-1",
      providerReference: "provider-payment-1",
      status: "succeeded",
      amount: createMoney(50_000, "XAF"),
      verifiedAt: "2026-10-05T07:06:00.000Z"
    },
    financials: {
      providerFee: createMoney(1_000, "XAF"),
      merchantShare: createMoney(47_500, "XAF"),
      platformCommission: createMoney(1_500, "XAF")
    }
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.run.status, "discrepancy");

  const types = new Set(result.value.run.discrepancies.map((item) => item.type));
  assert.equal(types.has("status_mismatch"), true);
  assert.equal(types.has("ledger_component_missing"), true);
  assert.equal(types.has("ledger_component_mismatch"), true);
});

test("reconciliation rejects cross-project and cross-merchant scope", async () => {
  const { reconciliation } = fixture();

  const wrongProject = await reconciliation.reconcilePayment({
    projectId: "project-other",
    merchantId: "merchant-centre-a",
    provider: "provider-a",
    payment: payment(),
    authoritative: {
      externalReference: "zamari-payment-1",
      providerReference: "provider-payment-1",
      status: "succeeded",
      amount: createMoney(50_000, "XAF"),
      verifiedAt: "2026-10-05T07:06:00.000Z"
    }
  });

  assert.equal(wrongProject.ok, false);
  if (!wrongProject.ok) {
    assert.equal(wrongProject.error.code, "scope_mismatch");
  }

  const wrongMerchant = await reconciliation.reconcilePayment({
    projectId: "project-zamari",
    merchantId: "merchant-other",
    provider: "provider-a",
    payment: payment(),
    authoritative: {
      externalReference: "zamari-payment-1",
      providerReference: "provider-payment-1",
      status: "succeeded",
      amount: createMoney(50_000, "XAF"),
      verifiedAt: "2026-10-05T07:06:00.000Z"
    }
  });

  assert.equal(wrongMerchant.ok, false);
  if (!wrongMerchant.ok) {
    assert.equal(wrongMerchant.error.code, "scope_mismatch");
  }
});

test("settlement reconciliation is explicit and replay-safe", async () => {
  const { ledger, reconciliation } = fixture();

  const settlement: Settlement = {
    id: "settlement-1",
    merchantId: "merchant-centre-a",
    providerAccountId: "provider-account-1",
    amount: createMoney(47_500, "XAF"),
    status: "settled",
    providerReference: "provider-settlement-1",
    settledAt: "2026-10-05T08:00:00.000Z"
  };

  await ledger.observeSettlement({
    projectId: "project-zamari",
    merchantId: "merchant-centre-a",
    paymentId: "payment-1",
    settlementId: settlement.id,
    sourceKey: "settlement:settlement-1:observed:v1",
    amount: settlement.amount,
    status: settlement.status,
    provider: "provider-a",
    providerReference: settlement.providerReference,
    occurredAt: "2026-10-05T08:00:00.000Z"
  });

  const input = {
    projectId: "project-zamari",
    merchantId: "merchant-centre-a",
    provider: "provider-a",
    settlement,
    authoritative: settlement
  };

  const first = await reconciliation.reconcileSettlement(input);
  const replay = await reconciliation.reconcileSettlement(input);

  assert.equal(first.ok, true);
  assert.equal(replay.ok, true);
  if (!first.ok || !replay.ok) return;

  assert.equal(first.value.run.status, "matched");
  assert.equal(replay.value.replayed, true);
  assert.equal(first.value.run.id, replay.value.run.id);
});

test("reconciliation run listing stays project scoped", async () => {
  const { ledger, reconciliation } = fixture();

  await ledger.recordPaymentBreakdown({
    projectId: "project-zamari",
    merchantId: "merchant-centre-a",
    paymentId: "payment-1",
    sourceKey: "payment:payment-1:verified:v1",
    gross: createMoney(50_000, "XAF"),
    provider: "provider-a",
    providerReference: "provider-payment-1",
    occurredAt: "2026-10-05T07:05:00.000Z"
  });

  await reconciliation.reconcilePayment({
    projectId: "project-zamari",
    merchantId: "merchant-centre-a",
    provider: "provider-a",
    payment: payment(),
    authoritative: {
      externalReference: "zamari-payment-1",
      providerReference: "provider-payment-1",
      status: "succeeded",
      amount: createMoney(50_000, "XAF"),
      verifiedAt: "2026-10-05T07:06:00.000Z"
    }
  });

  const zamari = await reconciliation.listRuns({
    projectId: "project-zamari"
  });
  const other = await reconciliation.listRuns({
    projectId: "project-other"
  });

  assert.equal(zamari.length, 1);
  assert.equal(other.length, 0);
});
