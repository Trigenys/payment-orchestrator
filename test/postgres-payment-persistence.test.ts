import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { createMoney } from "../src/domain/money.js";
import { PaymentService } from "../src/payments/service.js";
import {
  checkPostgresReadiness,
  PostgresPaymentPersistence
} from "../src/storage/postgres/payment-persistence.js";
import { migrate } from "../src/storage/postgres/migrate.js";

const url = process.env.POSTGRES_TEST_URL;

test("PostgreSQL payment persistence: real database contract", {
  skip: url ? false : "POSTGRES_TEST_URL is not configured"
}, async (t) => {
  const pool = new Pool({ connectionString: url!, max: 8 });
  const secondPool = new Pool({ connectionString: url!, max: 8 });

  try {
    await migrate(pool);
    await migrate(pool); // Idempotent migration.
    assert.equal(await checkPostgresReadiness(pool), true);

    const suffix = randomUUID();
    const projectId = `test-project-${suffix}`;
    const merchantId = `test-merchant-${suffix}`;

    await pool.query(
      `INSERT INTO payment_projects (id,name,status)
       VALUES ($1,'Tests','active')`,
      [projectId]
    );
    await pool.query(
      `INSERT INTO payment_merchants
       (id,project_id,display_name,country,status)
       VALUES ($1,$2,'Test Merchant','CM','active')`,
      [merchantId, projectId]
    );

    const firstPersistence = new PostgresPaymentPersistence(pool);
    const secondPersistence = new PostgresPaymentPersistence(secondPool);
    const one = new PaymentService({ persistence: firstPersistence });
    const two = new PaymentService({ persistence: secondPersistence });

    const command = (key: string, reference = key) => ({
      projectId, merchantId, externalReference: reference,
      amount: createMoney(150, "XAF"),
      channel: "mobile_money" as const,
      idempotencyKey: key
    });

    await t.test("replay and uniqueness survive competing services and restart", async () => {
      const key = `concurrent-${suffix}`;
      const writes = await Promise.all(
        Array.from({ length: 12 }, (_, i) => (i % 2 ? two : one).createPayment(command(key)))
      );
      assert.equal(writes.filter((r) => r.ok).length, 12);
      const values = writes.filter((r) => r.ok).map((r) => r.value);
      assert.equal(new Set(values.map((v) => v.payment.id)).size, 1);
      assert.equal(values.filter((v) => !v.replayed).length, 1);

      const replacementService = new PaymentService({
        persistence: new PostgresPaymentPersistence(secondPool)
      });
      const restarted = await replacementService.createPayment(command(key));
      assert.equal(restarted.ok, true);
      if (!restarted.ok) return;
      assert.equal(restarted.value.replayed, true);
      assert.equal(restarted.value.payment.id, values[0]?.payment.id);

      const sameKeyDifferentAmount = await two.createPayment({
        ...command(key), amount: createMoney(200, "XAF")
      });
      assert.equal(sameKeyDifferentAmount.ok, false);
      if (!sameKeyDifferentAmount.ok) {
        assert.equal(sameKeyDifferentAmount.error.code, "idempotency_conflict");
      }

      const audit = await one.getPaymentAudit(restarted.value.payment.id);
      assert.equal(audit.ok, true);
      if (audit.ok) assert.equal(audit.value.transitions.length, 1);
    });

    await t.test("PSP reference conflicts and repeated status are safe", async () => {
      const first = await one.createPayment(command(`binding-1-${suffix}`));
      const second = await two.createPayment(command(`binding-2-${suffix}`));
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      if (!first.ok || !second.ok) return;

      const providerPaymentReference = `psp-${suffix}`;
      const binding = {
        paymentId: first.value.payment.id,
        provider: "fapshi",
        environment: "sandbox" as const,
        providerPaymentReference
      };
      const bound = await one.bindProviderReference(binding);
      const replay = await two.bindProviderReference(binding);
      assert.equal(bound.ok, true);
      assert.equal(replay.ok, true);
      if (replay.ok) assert.equal(replay.value.replayed, true);

      const conflicting = await two.bindProviderReference({
        ...binding, paymentId: second.value.payment.id
      });
      assert.equal(conflicting.ok, false);
      if (!conflicting.ok) {
        assert.equal(conflicting.error.code, "provider_reference_conflict");
      }

      const evt = {
        provider: "fapshi", environment: "sandbox" as const,
        providerPaymentReference,
        eventId: `ev-${suffix}`,
        status: "succeeded" as const,
        occurredAt: "2026-10-19T09:00:00.000Z"
      };
      const receipts = await Promise.all(
        Array.from({ length: 6 }, (_, i) => (i % 2 ? one : two).ingestProviderEvent(evt))
      );
      assert.ok(receipts.every((r) => r.ok));
      assert.equal(receipts.filter((r) => r.ok && !r.value.replayed).length, 1);

      const audit = await two.getPaymentAudit(first.value.payment.id);
      assert.equal(audit.ok, true);
      if (!audit.ok) return;
      assert.equal(audit.value.payment.status, "succeeded");
      assert.equal(audit.value.providerEvents.length, 1);
      assert.equal(audit.value.transitions.length, 2);
      assert.equal(audit.value.transitions[1]?.toStatus, "succeeded");
    });

    await t.test("failed transaction rolls back all writes", async () => {
      const tempId = `rollback-${suffix}`;
      await assert.rejects(
        firstPersistence.transaction(async (tx) => {
          await tx.putPayment({
            id: tempId, projectId, merchantId,
            amount: createMoney(150, "XAF"),
            externalReference: tempId, status: "created",
            version: 1, createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          });
          throw new Error("force rollback");
        }),
        /force rollback/
      );
      const after = await firstPersistence.transaction((tx) => tx.getPayment(tempId));
      assert.equal(after, undefined);
    });

    await t.test("foreign keys prevent phantom merchants", async () => {
      const other = await one.createPayment({
        ...command(`bad-merchant-${suffix}`),
        merchantId: "nonexistent-merchant"
      });
      // A database invariant throws, not a fake successful payment.
      assert.equal(other.ok, false);
    });
  } finally {
    await Promise.all([pool.end(), secondPool.end()]);
  }
});
