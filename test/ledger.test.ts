import assert from "node:assert/strict";
import test from "node:test";
import { createMoney } from "../src/domain/money.js";
import { InMemoryLedgerPersistence } from "../src/ledger/persistence.js";
import { LedgerService } from "../src/ledger/service.js";

function fixture() {
  let id = 0;
  let tick = 0;

  const persistence = new InMemoryLedgerPersistence();
  const service = new LedgerService({
    persistence,
    newId: () => `ledger-${++id}`,
    now: () =>
      new Date(
        Date.UTC(2026, 9, 4, 22, 0, tick++)
      ).toISOString()
  });

  return { persistence, service };
}

const breakdown = {
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
  occurredAt: "2026-10-04T21:59:00.000Z"
};

test("payment breakdown records immutable financial components", async () => {
  const { service } = fixture();

  const result = await service.recordPaymentBreakdown(breakdown);

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.replayed, false);
  assert.deepEqual(
    result.value.entries.map((entry) => entry.kind),
    [
      "payment_gross",
      "provider_fee",
      "merchant_share",
      "platform_commission"
    ]
  );
  assert.ok(
    result.value.entries.every(
      (entry) => entry.amount.currency === "XAF"
    )
  );
});

test("same deterministic source key and evidence replays one ledger batch", async () => {
  const { service } = fixture();

  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      service.recordPaymentBreakdown(breakdown)
    )
  );

  assert.ok(results.every((result) => result.ok));
  const successful = results.filter((result) => result.ok);
  if (successful.length !== results.length) return;

  assert.equal(
    new Set(
      successful.map((result) => result.value.batch.id)
    ).size,
    1
  );
  assert.equal(
    successful.filter((result) => !result.value.replayed)
      .length,
    1
  );
  assert.equal(
    successful.filter((result) => result.value.replayed)
      .length,
    19
  );
});

test("same source key with different financial evidence conflicts", async () => {
  const { service } = fixture();

  await service.recordPaymentBreakdown(breakdown);

  const conflict = await service.recordPaymentBreakdown({
    ...breakdown,
    merchantShare: createMoney(48_000, "XAF")
  });

  assert.equal(conflict.ok, false);
  if (conflict.ok) return;

  assert.equal(conflict.error.code, "ledger_conflict");
});

test("refunds append evidence without rewriting original gross entry", async () => {
  const { service } = fixture();

  await service.recordPaymentBreakdown(breakdown);

  const refund = await service.recordRefund({
    projectId: breakdown.projectId,
    merchantId: breakdown.merchantId,
    paymentId: breakdown.paymentId,
    sourceKey: "refund:refund-1",
    amount: createMoney(10_000, "XAF"),
    provider: "provider-a",
    providerReference: "provider-refund-1",
    occurredAt: "2026-10-04T22:05:00.000Z"
  });

  assert.equal(refund.ok, true);

  const entries = await service.listEntries({
    projectId: breakdown.projectId,
    merchantId: breakdown.merchantId,
    paymentId: breakdown.paymentId
  });

  assert.equal(
    entries.filter((entry) => entry.kind === "payment_gross")
      .length,
    1
  );
  assert.equal(
    entries.filter((entry) => entry.kind === "refund")
      .length,
    1
  );

  const gross = entries.find(
    (entry) => entry.kind === "payment_gross"
  );
  assert.equal(gross?.amount.amountMinor, 50_000);
});

test("adjustments are new append-only evidence with explicit direction", async () => {
  const { service } = fixture();

  const adjustment = await service.recordAdjustment({
    projectId: "project-zamari",
    merchantId: "merchant-centre-a",
    paymentId: "payment-1",
    sourceKey: "adjustment:manual-1",
    amount: createMoney(500, "XAF"),
    direction: "decrease",
    reason: "Provider fee correction",
    occurredAt: "2026-10-04T22:10:00.000Z"
  });

  assert.equal(adjustment.ok, true);
  if (!adjustment.ok) return;

  assert.equal(
    adjustment.value.entries[0]?.adjustmentDirection,
    "decrease"
  );
  assert.equal(
    adjustment.value.entries[0]?.metadata?.reason,
    "Provider fee correction"
  );
});

test("mixed currencies in one evidence batch fail closed", async () => {
  const { service } = fixture();

  const result = await service.recordPaymentBreakdown({
    ...breakdown,
    providerFee: createMoney(100, "USD")
  });

  assert.equal(result.ok, false);
  if (result.ok) return;

  assert.match(result.error.message, /same currency/i);
});

test("ledger queries are project and merchant scoped", async () => {
  const { service } = fixture();

  await service.recordPaymentBreakdown(breakdown);

  await service.recordPaymentBreakdown({
    ...breakdown,
    projectId: "project-other",
    merchantId: "merchant-other",
    paymentId: "payment-other",
    sourceKey: "payment:other:verified:v1",
    providerReference: "provider-payment-other"
  });

  const zamari = await service.listEntries({
    projectId: "project-zamari"
  });
  const other = await service.listEntries({
    projectId: "project-other"
  });
  const wrongMerchant = await service.listEntries({
    projectId: "project-zamari",
    merchantId: "merchant-other"
  });

  assert.equal(zamari.length, 4);
  assert.equal(other.length, 4);
  assert.equal(wrongMerchant.length, 0);
  assert.ok(
    zamari.every(
      (entry) =>
        entry.projectId === "project-zamari" &&
        entry.merchantId === "merchant-centre-a"
    )
  );
});

test("settlement observations are append-only status evidence", async () => {
  const { service } = fixture();

  const result = await service.observeSettlement({
    projectId: "project-zamari",
    merchantId: "merchant-centre-a",
    paymentId: "payment-1",
    settlementId: "settlement-1",
    sourceKey: "settlement:settlement-1:observed:v1",
    amount: createMoney(47_500, "XAF"),
    status: "in_transit",
    provider: "provider-a",
    providerReference: "provider-settlement-1",
    occurredAt: "2026-10-05T08:00:00.000Z"
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(
    result.value.entries[0]?.kind,
    "settlement_observed"
  );
  assert.equal(
    result.value.entries[0]?.settlementStatus,
    "in_transit"
  );
});


test("payout observations are append-only evidence", async () => {
  const { service } = fixture();

  const result = await service.observePayout({
    projectId: "project-zamari",
    merchantId: "merchant-centre-a",
    paymentId: "payment-1",
    sourceKey: "payout:payout-1:observed:v1",
    amount: createMoney(47_500, "XAF"),
    provider: "provider-a",
    providerReference: "provider-payout-1",
    occurredAt: "2026-10-05T08:15:00.000Z"
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.entries[0]?.kind, "payout_observed");
  assert.equal(result.value.entries[0]?.amount.amountMinor, 47_500);
});
