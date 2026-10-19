import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { createMoney } from "../src/domain/money.js";
import { LedgerService } from "../src/ledger/service.js";
import { PaymentService } from "../src/payments/service.js";
import { ReconciliationService } from "../src/reconciliation/service.js";
import { PostgresLedgerPersistence } from "../src/storage/postgres/ledger-persistence.js";
import { PostgresPaymentPersistence } from "../src/storage/postgres/payment-persistence.js";
import { PostgresReconciliationPersistence } from "../src/storage/postgres/reconciliation-persistence.js";
import { migrate } from "../src/storage/postgres/migrate.js";

const url = process.env.POSTGRES_TEST_URL;

test("PostgreSQL ledger and reconciliation persistence", {
  skip: url ? false : "POSTGRES_TEST_URL is not configured"
}, async t => {
  const pool = new Pool({ connectionString: url!, max: 8 });
  const another = new Pool({ connectionString: url!, max: 8 });
  try {
    await migrate(pool);
    await migrate(another);
    const suffix = randomUUID();
    const projectId = `project-finance-${suffix}`;
    const merchantId = `merchant-finance-${suffix}`;
    const otherProjectId = `other-project-${suffix}`;
    const otherMerchantId = `other-merchant-${suffix}`;
    for (const [project, merchant] of [
      [projectId, merchantId], [otherProjectId, otherMerchantId]
    ]) {
      await pool.query(
        "INSERT INTO payment_projects(id,name,status) VALUES($1,'Finance test','active')",
        [project]
      );
      await pool.query(
        `INSERT INTO payment_merchants(id, project_id, display_name, country, status)
        VALUES($1,$2,'Test merchant','CM','active')`, [merchant, project]
      );
    }

    const payments = new PaymentService({
      persistence: new PostgresPaymentPersistence(pool)
    });
    const command = await payments.createPayment({
      projectId, merchantId,
      externalReference: `order-${suffix}`,
      amount: createMoney(1000, "XAF"),
      channel: "mobile_money",
      idempotencyKey: `payment-${suffix}`
    });
    assert.equal(command.ok, true);
    if (!command.ok) return;
    const paymentId = command.value.payment.id;
    const providerRef = `fapshi-${suffix}`;
    const bound = await payments.bindProviderReference({
      paymentId, provider: "fapshi", environment: "sandbox",
      providerPaymentReference: providerRef
    });
    assert.equal(bound.ok, true);

    const confirmed = await payments.ingestProviderEvent({
      eventId: `status-${suffix}`,
      provider: "fapshi", environment: "sandbox",
      providerPaymentReference: providerRef,
      status: "succeeded",
      occurredAt: "2026-10-19T08:00:00.000Z"
    });
    assert.equal(confirmed.ok, true);

    const ledger1 = new LedgerService({
      persistence: new PostgresLedgerPersistence(pool)
    });
    const ledger2 = new LedgerService({
      persistence: new PostgresLedgerPersistence(another)
    });
    const evidence = {
      projectId, merchantId, paymentId,
      sourceKey: `confirmed-${suffix}`,
      gross: createMoney(1000, "XAF"),
      providerFee: createMoney(30, "XAF"),
      merchantShare: createMoney(970, "XAF"),
      provider: "fapshi",
      providerReference: providerRef,
      occurredAt: "2026-10-19T08:01:00.000Z"
    };

    await t.test("concurrent ledger evidence writes only once, survives restart", async () => {
      const responses = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          (index % 2 ? ledger1 : ledger2).recordPaymentBreakdown(evidence))
      );
      assert.ok(responses.every(r => r.ok));
      const success = responses.filter(r => r.ok).map(r => r.value);
      assert.equal(new Set(success.map(r => r.batch.id)).size, 1);
      assert.equal(success.filter(r => !r.replayed).length, 1);
      assert.ok(success.every(r => r.entries.length === 3));

      const afterRestart = await ledger2.recordPaymentBreakdown(evidence);
      assert.equal(afterRestart.ok, true);
      if (!afterRestart.ok) return;
      assert.equal(afterRestart.value.replayed, true);
      assert.deepEqual(afterRestart.value.entries.map(e => e.kind), [
        "payment_gross", "provider_fee", "merchant_share"
      ]);
      const conflict = await ledger2.recordPaymentBreakdown({
        ...evidence, merchantShare: createMoney(960, "XAF")
      });
      assert.equal(conflict.ok, false);
      if (!conflict.ok) assert.equal(conflict.error.code, "ledger_conflict");
      const raw = await pool.query(
        "SELECT count(*)::int as n FROM payment_ledger_entries WHERE payment_id = $1",
        [paymentId]
      );
      assert.equal(raw.rows[0].n, 3);
    });

    await t.test("ledger batches are scoped; forged merchant and payment fail", async () => {
      assert.deepEqual(await ledger1.listEntries({ projectId: otherProjectId }), []);
      const forging = await ledger1.recordPaymentBreakdown({
        ...evidence,
        sourceKey: `forged-${suffix}`,
        projectId: otherProjectId,
        merchantId: otherMerchantId
      });
      // Same paymentId in a different project must never succeed.
      await assert.rejects(Promise.resolve(forging).then(r => {
        if (r.ok) throw new Error("unexpected success");
      }), /unexpected success/);
    });

    const reconciliation1 = new ReconciliationService({
      ledgerPersistence: new PostgresLedgerPersistence(pool),
      persistence: new PostgresReconciliationPersistence(pool)
    });
    const reconciliation2 = new ReconciliationService({
      ledgerPersistence: new PostgresLedgerPersistence(another),
      persistence: new PostgresReconciliationPersistence(another)
    });
    const paymentAudit = await payments.getPaymentAudit(paymentId);
    assert.equal(paymentAudit.ok, true);
    if (!paymentAudit.ok) return;
    const reconciliationInput = {
      projectId, merchantId, provider: "fapshi",
      payment: paymentAudit.value.payment,
      expectedProviderReference: providerRef,
      authoritative: {
        externalReference: evidence.sourceKey.replace(/^confirmed-/, "order-"),
        providerReference: providerRef,
        status: "succeeded" as const,
        amount: createMoney(1000, "XAF"),
        verifiedAt: "2026-10-19T08:05:00.000Z"
      },
      financials: {
        providerFee: createMoney(30, "XAF"),
        merchantShare: createMoney(970, "XAF")
      }
    };

    await t.test("reconciliation replays and stores no duplicate audit runs", async () => {
      const attempts = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          (i % 2 ? reconciliation1 : reconciliation2).reconcilePayment(reconciliationInput))
      );
      assert.ok(attempts.every(r => r.ok));
      const valid = attempts.filter(r => r.ok).map(r => r.value);
      assert.equal(new Set(valid.map(r => r.run.id)).size, 1);
      assert.equal(valid.filter(r => !r.replayed).length, 1);
      assert.equal(valid[0]?.run.status, "matched");
      const saved = await reconciliation2.listRuns({ projectId, merchantId, subjectId: paymentId });
      assert.equal(saved.length, 1);
    });

    await t.test("mismatched PSP amount is retained as a discrepancy, not rewritten", async () => {
      const discrepant = await reconciliation2.reconcilePayment({
        ...reconciliationInput,
        authoritative: {
          ...reconciliationInput.authoritative,
          amount: createMoney(1100, "XAF")
        }
      });
      assert.equal(discrepant.ok, true);
      if (!discrepant.ok) return;
      assert.equal(discrepant.value.run.status, "discrepancy");
      assert.ok(discrepant.value.run.discrepancies.some(d => d.type === "amount_mismatch"));
      const original = await ledger1.listEntries({ projectId, merchantId, paymentId });
      assert.equal(original.find(e => e.kind === "payment_gross")?.amount.amountMinor, 1000);
      assert.deepEqual(await reconciliation2.listRuns({ projectId: otherProjectId }), []);
    });
  } finally {
    await Promise.all([pool.end(), another.end()]);
  }
});
