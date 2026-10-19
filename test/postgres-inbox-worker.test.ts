import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { createMoney } from "../src/domain/money.js";
import { PaymentService } from "../src/payments/service.js";
import { PostgresMessageStore } from "../src/storage/postgres/durable-messages.js";
import { PostgresPaymentPersistence } from "../src/storage/postgres/payment-persistence.js";
import { migrate } from "../src/storage/postgres/migrate.js";
import { PostgresInboxWorkerStore } from "../src/worker/inbox-persistence.js";

const url = process.env.POSTGRES_TEST_URL;
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

test("PostgreSQL inbox worker: fenced lease, durable retries and tenant-scoped binding", {
  skip: url ? false : "POSTGRES_TEST_URL is not set"
}, async t => {
  const pool = new Pool({ connectionString: url!, max: 8 });
  const other = new Pool({ connectionString: url!, max: 8 });
  try {
    await migrate(pool);
    const suffix = randomUUID();
    const serviceName = `service-${suffix}`;
    const trans1 = `psp-one-${suffix}`;
    const trans2 = `psp-two-${suffix}`;
    const store = new PostgresInboxWorkerStore(pool, serviceName);
    const competitor = new PostgresInboxWorkerStore(other, serviceName);
    const msg = new PostgresMessageStore(pool);
    for (const [ref, status] of [[trans1, "SUCCESSFUL"], [trans2, "FAILED"]] as const) {
      const receipt = await msg.recordInbox({
        provider: "fapshi", environment: "sandbox",
        providerReference: ref, eventFingerprint: hash(ref + status),
        payloadDigest: hash(status),
        payload: { transId: ref, status, serviceName }
      });
      assert.equal(receipt.replayed, false);
    }

    await t.test("two workers cannot claim same message, stale token cannot ACK", async () => {
      const claimed = await Promise.all([store.claim(3), competitor.claim(3)]);
      assert.equal(claimed.flat().length, 2);
      const one = claimed.flat().find(m => m.providerReference === trans1)!;
      const two = claimed.flat().find(m => m.providerReference === trans2)!;
      assert.ok(one && two);
      assert.equal(await competitor.complete({ ...one, leaseToken: "forged" }), false);
      assert.equal(await store.complete(two), true);
      assert.equal((await competitor.claim(3)).length, 0);

      // Simulate worker dying without ACK; database lease expires naturally.
      await pool.query(
        "UPDATE payment_webhook_inbox SET leased_until=now()-INTERVAL '2 seconds' WHERE id=$1",
        [one.id]
      );
      const recovered = await competitor.claim(3);
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0]?.id, one.id);
      assert.notEqual(recovered[0]?.leaseToken, one.leaseToken);
      assert.equal(await store.complete(one), false);
      assert.equal(await competitor.complete(recovered[0]!), true);
      assert.equal((await store.claim(3)).length, 0);
    });

    await t.test("provider quota deferral preserves attempts, while failures quarantine", async () => {
      const ref = `retry-${suffix}`;
      await msg.recordInbox({
        provider: "fapshi", environment: "sandbox",
        providerReference: ref, eventFingerprint: hash(ref),
        payloadDigest: hash("SUCCESSFUL"), payload: {
          transId: ref, status: "SUCCESSFUL", serviceName
        }
      });
      const first = (await store.claim(2))[0]!;
      assert.equal(first.providerReference, ref);
      assert.equal(first.attemptCount, 1);
      assert.equal(await store.deferRateLimit(first, 75), true);
      assert.equal(await store.complete(first), false);
      const persisted = await pool.query<{ attempt_count: number }>(
        "SELECT attempt_count FROM payment_webhook_inbox WHERE id=$1",
        [first.id]
      );
      assert.equal(persisted.rows[0]?.attempt_count, 0);

      await pool.query(
        "UPDATE payment_webhook_inbox SET next_attempt_at=now()-INTERVAL '1 second' WHERE id=$1",
        [first.id]
      );
      const second = (await competitor.claim())[0]!;
      assert.equal(second.attemptCount, 1);
      assert.equal(await competitor.retry(second, "NOT_VERIFIED", 1, 2), "retry_scheduled");
      await pool.query(
        "UPDATE payment_webhook_inbox SET next_attempt_at=now()-INTERVAL '1 second' WHERE id=$1",
        [first.id]
      );
      const third = (await store.claim())[0]!;
      assert.equal(third.attemptCount, 2);
      assert.equal(await store.retry(third, "NOT_VERIFIED", 1, 2), "quarantined");
      assert.equal((await competitor.claim()).length, 0);
    });

    await t.test("lookup requires configured project and merchant before PSP status call", async () => {
      const projectId = `project-worker-${suffix}`;
      const otherProjectId = `other-worker-${suffix}`;
      const merchantId = `merchant-worker-${suffix}`;
      await pool.query(
        "INSERT INTO payment_projects(id,name,status) VALUES($1,'Worker','active'),($2,'Other','active')",
        [projectId, otherProjectId]
      );
      await pool.query(
        `INSERT INTO payment_merchants(id,project_id,display_name,country,status)
         VALUES($1,$2,'Merchant','CM','active')`,
        [merchantId, projectId]
      );
      const service = new PaymentService({
        persistence: new PostgresPaymentPersistence(pool)
      });
      const order = `order-worker-${suffix}`;
      const p = await service.createPayment({
        projectId, merchantId, externalReference: order,
        amount: createMoney(150, "XAF"), channel: "mobile_money",
        idempotencyKey: order
      });
      assert.equal(p.ok, true);
      if (!p.ok) return;
      const paymentId = p.value.payment.id;
      const binding = await service.bindProviderReference({
        paymentId, provider: "fapshi", environment: "sandbox",
        providerPaymentReference: `ref-worker-${suffix}`
      });
      assert.equal(binding.ok, true);
      const ref = `ref-worker-${suffix}`;
      assert.equal(await store.findBoundPayment(ref, projectId, merchantId), paymentId);
      assert.equal(await store.findBoundPayment(ref, otherProjectId, merchantId), undefined);
      assert.equal(await store.findBoundPayment("not-known", projectId, merchantId), undefined);
    });
  } finally {
    await Promise.all([pool.end(), other.end()]);
  }
});
