import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { createMoney } from "../src/domain/money.js";
import { LedgerService } from "../src/ledger/service.js";
import { PaymentService } from "../src/payments/service.js";
import { PostgresLedgerPersistence } from "../src/storage/postgres/ledger-persistence.js";
import { PostgresPaymentPersistence } from "../src/storage/postgres/payment-persistence.js";
import { PostgresMessageStore } from "../src/storage/postgres/durable-messages.js";
import { migrate } from "../src/storage/postgres/migrate.js";
import { isOutboxPaymentVerified } from "../src/worker/outbox-run-once.js";
import { PrecisOutboxWorker } from "../src/worker/precis-outbox-worker.js";

const url = process.env.POSTGRES_TEST_URL;
test("signed outbox: persisted success + immutable journal before delivery, replay-safe leases", {
  skip: url ? false : "POSTGRES_TEST_URL is not configured"
}, async () => {
  const pool = new Pool({ connectionString: url!, max: 8 });
  const other = new Pool({ connectionString: url!, max: 8 });
  try {
    await migrate(pool);
    const suffix = randomUUID();
    const projectId = `precis-signing-project-${suffix}`;
    const merchantId = `precis-signing-merchant-${suffix}`;
    const reference = `signed-order-${suffix}`;
    const providerReference = `signed-provider-${suffix}`;
    await pool.query(
      "INSERT INTO payment_projects(id,name,status) VALUES($1,'Signed test','active')",
      [projectId]
    );
    await pool.query(
      `INSERT INTO payment_merchants(id,project_id,display_name,country,status)
       VALUES($1,$2,'Signed merchant','CM','active')`,
      [merchantId, projectId]
    );
    const payments = new PaymentService({ persistence: new PostgresPaymentPersistence(pool) });
    const created = await payments.createPayment({
      projectId, merchantId, externalReference: reference,
      amount: createMoney(150, "XAF"), channel: "mobile_money",
      idempotencyKey: `signed-create-${suffix}`
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const paymentId = created.value.payment.id;
    const bound = await payments.bindProviderReference({
      paymentId, provider: "fapshi", environment: "sandbox",
      providerPaymentReference: providerReference
    });
    assert.equal(bound.ok, true);

    const messages = new PostgresMessageStore(pool);
    const receipt = await messages.enqueue({
      projectId, paymentId, destination: "precis-payment-events",
      effectKey: `confirmed-${paymentId}`,
      payload: {
        eventType: "payment.confirmed", projectId, merchantId,
        paymentId, externalReference: reference, provider: "fapshi",
        providerReference, currency: "XAF", amountMinor: 150
      }
    });
    const candidate = (await messages.lease(projectId, 1, 60))[0]!;
    assert.equal(candidate.id, receipt.id);
    assert.equal(await isOutboxPaymentVerified(pool, candidate, "sandbox"), false);

    const applied = await payments.ingestProviderEvent({
      eventId: `signed-success-${suffix}`, provider: "fapshi",
      environment: "sandbox", providerPaymentReference: providerReference,
      status: "succeeded", occurredAt: "2026-10-28T00:00:00Z"
    });
    assert.equal(applied.ok, true);
    assert.equal(await isOutboxPaymentVerified(pool, candidate, "sandbox"), false);

    const ledger = await new LedgerService({
      persistence: new PostgresLedgerPersistence(pool)
    }).recordPaymentBreakdown({
      projectId, merchantId, paymentId,
      sourceKey: `fapshi:${paymentId}:confirmed:v1`,
      gross: createMoney(150, "XAF"),
      providerFee: createMoney(10, "XAF"),
      merchantShare: createMoney(140, "XAF"),
      provider: "fapshi", providerReference,
      occurredAt: "2026-10-28T00:00:00Z",
      metadata: { providerStatus: "SUCCESSFUL", serviceName: "sandbox" }
    });
    assert.equal(ledger.ok, true);
    assert.equal(await isOutboxPaymentVerified(pool, candidate, "sandbox"), true);
    assert.equal(await isOutboxPaymentVerified(pool, candidate, "live"), false);
    assert.equal(await isOutboxPaymentVerified(pool, {
      ...candidate, payload: { ...candidate.payload, amountMinor: 999 }
    }, "sandbox"), false);

    // Reclaim an expired lease just as happens after process death.
    await pool.query(
      "UPDATE payment_outbox SET leased_until=now()-INTERVAL '1 second' WHERE id=$1",
      [receipt.id]
    );
    let requests = 0;
    const worker = new PrecisOutboxWorker({
      store: new PostgresMessageStore(other), environment: "sandbox",
      projectId, endpoint: "https://precis-translator.trigenys.com/api/payments/orchestrator/events",
      signingKey: { keyId: "sandbox-v1", secret: "s".repeat(48) },
      isVerifiedPayment: (m, mode) => isOutboxPaymentVerified(other, m, mode),
      fetchImpl: async (_input, init) => {
        requests++;
        const eventId = (init?.headers as Record<string,string>)["x-trigenys-event-id"];
        return new Response(null, {
          status: 204, headers: { "x-trigenys-event-ack": eventId }
        });
      }
    });
    const delivered = await worker.runBatch();
    assert.equal(delivered.delivered, 1);
    assert.equal(requests, 1);
    assert.equal(await messages.acknowledge(candidate.id, candidate.leaseToken), false);
    const afterwards = await pool.query<{ status: string; attempt_count: number }>(
      "SELECT status,attempt_count FROM payment_outbox WHERE id=$1",
      [receipt.id]
    );
    assert.equal(afterwards.rows[0]?.status, "delivered");
    assert.equal(afterwards.rows[0]?.attempt_count, 2);
    assert.equal((await worker.runBatch()).claimed, 0);
  } finally {
    await Promise.all([pool.end(), other.end()]);
  }
});
