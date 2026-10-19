import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { createMoney } from "../src/domain/money.js";
import { PaymentService } from "../src/payments/service.js";
import { migrate } from "../src/storage/postgres/migrate.js";
import { PostgresPaymentPersistence } from "../src/storage/postgres/payment-persistence.js";
import {
  PostgresMessageStore, enqueueOutboxInTransaction
} from "../src/storage/postgres/durable-messages.js";

const url = process.env.POSTGRES_TEST_URL;
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

test("PostgreSQL durable webhook inbox and notification outbox", {
  skip: url ? false : "POSTGRES_TEST_URL is not configured"
}, async t => {
  const pool = new Pool({ connectionString: url!, max: 8 });
  const other = new Pool({ connectionString: url!, max: 8 });

  try {
    await migrate(pool);
    const suffix = randomUUID();
    const projectId = `message-project-${suffix}`;
    const merchantId = `message-merchant-${suffix}`;
    const foreignProjectId = `message-foreign-${suffix}`;
    await pool.query(
      "INSERT INTO payment_projects (id,name,status) VALUES($1,'Msg','active'),($2,'Other','active')",
      [projectId, foreignProjectId]
    );
    await pool.query(
      `INSERT INTO payment_merchants(id,project_id,display_name,country,status)
       VALUES($1,$2,'Merchant','CM','active')`,
      [merchantId, projectId]
    );
    const payments = new PaymentService({ persistence: new PostgresPaymentPersistence(pool) });
    const created = await payments.createPayment({
      projectId, merchantId, amount: createMoney(150, "XAF"),
      externalReference: `order-${suffix}`,
      channel: "mobile_money",
      idempotencyKey: `create-${suffix}`
    });
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const paymentId = created.value.payment.id;
    const inbox = new PostgresMessageStore(pool);
    const another = new PostgresMessageStore(other);
    const event = {
      provider: "fapshi",
      environment: "sandbox" as const,
      providerReference: `trans-${suffix}`,
      eventFingerprint: sha256(`fapshi:sandbox:trans-${suffix}:PENDING`),
      payloadDigest: sha256("PENDING"),
      payload: { transaction: `trans-${suffix}`, state: "PENDING" }
    };

    await t.test("duplicate inbox events across processes are one receipt", async () => {
      const responses = await Promise.all(
        Array.from({ length: 10 }, (_, i) => (i % 2 ? inbox : another).recordInbox(event))
      );
      assert.equal(responses.filter(r => !r.replayed).length, 1);
      assert.equal(new Set(responses.map(r => r.id)).size, 1);
      const mismatch = { ...event, payloadDigest: sha256("DIFFERENT") };
      await assert.rejects(inbox.recordInbox(mismatch), /collides/);
      const differentEnvironment = await inbox.recordInbox({ ...event, environment: "live" });
      assert.equal(differentEnvironment.replayed, false);
    });

    const message = {
      projectId, paymentId,
      destination: "precis-grants",
      effectKey: `entitlement-${suffix}`,
      payload: { paymentId, grant: { pages: 2 }, verified: true }
    };

    await t.test("replay-safe outbox and conflicting evidence are blocked", async () => {
      const replies = await Promise.all(
        Array.from({ length: 10 }, (_, i) => (i % 2 ? inbox : another).enqueue(message))
      );
      assert.equal(replies.filter(r => !r.replayed).length, 1);
      assert.equal(new Set(replies.map(r => r.id)).size, 1);
      await assert.rejects(inbox.enqueue({
        ...message, payload: { grant: { pages: 99 } }
      }), /conflict/);
      await assert.rejects(inbox.enqueue({
        ...message, projectId: foreignProjectId, effectKey: `foreign-${suffix}`
      }), /scope mismatch/);
    });

    await t.test("lease fencing stops old workers from acknowledging another attempt", async () => {
      const first = await Promise.all([inbox.lease(projectId), another.lease(projectId)]);
      assert.equal(first.flat().length, 1);
      const current = first.flat()[0]!;
      const stale = await inbox.acknowledge(current.id, "forged-token");
      assert.equal(stale, false);

      // Crash simulation: lease expires and a new worker takes over.
      await pool.query(
        "UPDATE payment_outbox SET leased_until=NOW()-INTERVAL '1 second' WHERE id=$1",
        [current.id]
      );
      const second = await another.lease(projectId);
      assert.equal(second.length, 1);
      assert.notEqual(second[0]!.leaseToken, current.leaseToken);
      assert.equal(await inbox.acknowledge(current.id, current.leaseToken), false);
      assert.equal(await another.acknowledge(second[0]!.id, second[0]!.leaseToken), true);
      assert.equal((await inbox.lease(projectId)).length, 0);
    });

    await t.test("bounded retries end in dead letter and do not grant twice", async () => {
      const task = { ...message, effectKey: `retry-${suffix}` };
      const receipt = await inbox.enqueue(task);
      assert.equal(receipt.replayed, false);
      const first = (await inbox.lease(projectId)).find(x => x.id === receipt.id);
      assert.ok(first);
      if (!first) return;
      const retry = await inbox.retryOrQuarantine(first.id, first.leaseToken, "NETWORK_ERROR", 1, 2);
      assert.equal(retry, "retry_scheduled");
      assert.equal(await inbox.acknowledge(first.id, first.leaseToken), false);
      await pool.query(
        "UPDATE payment_outbox SET next_attempt_at=NOW()-INTERVAL '1 second' WHERE id=$1",
        [receipt.id]
      );
      const second = (await another.lease(projectId)).find(x => x.id === receipt.id);
      assert.ok(second);
      if (!second) return;
      assert.equal(await another.retryOrQuarantine(second.id, second.leaseToken, "NETWORK_ERROR", 1, 2), "dead_letter");
      assert.equal((await inbox.lease(projectId)).length, 0);
    });

    await t.test("transactional outbox insertion rolls back with its future business effect", async () => {
      const client = await pool.connect();
      const atomic = { ...message, effectKey: `atomic-${suffix}` };
      try {
        await client.query("BEGIN");
        await enqueueOutboxInTransaction(client, atomic);
        await client.query("ROLLBACK");
      } finally {
        client.release();
      }
      const outside = await another.enqueue(atomic);
      assert.equal(outside.replayed, false);
    });

    await t.test("corrupt and oversized event metadata is rejected", async () => {
      await assert.rejects(inbox.recordInbox({
        ...event, eventFingerprint: "not-sha256"
      }), /Invalid inbox/);
      await assert.rejects(inbox.recordInbox({
        ...event, eventFingerprint: sha256("oversized"),
        payload: { forbidden: "x".repeat(20_000) }
      }), /bounded/);
    });
  } finally {
    await Promise.all([pool.end(), other.end()]);
  }
});
