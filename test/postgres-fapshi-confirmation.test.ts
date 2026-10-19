import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { createMoney } from "../src/domain/money.js";
import { LedgerService } from "../src/ledger/service.js";
import { PaymentService } from "../src/payments/service.js";
import { FapshiHostedClient } from "../src/providers/fapshi/client.js";
import { FapshiHostedConnector } from "../src/providers/fapshi/connector.js";
import type {
  ProviderHttpClient, ProviderHttpRequest, ProviderHttpResponse
} from "../src/providers/http.js";
import { FapshiSandboxConfirmation } from "../src/storage/postgres/fapshi-confirmation.js";
import { PostgresLedgerPersistence } from "../src/storage/postgres/ledger-persistence.js";
import { PostgresPaymentPersistence } from "../src/storage/postgres/payment-persistence.js";
import { migrate } from "../src/storage/postgres/migrate.js";

const url = process.env.POSTGRES_TEST_URL;

class StatusStub implements ProviderHttpClient {
  readonly responses = new Map<string, { externalId: string; amount: number }>();
  providerStatus = "SUCCESSFUL";
  serviceName = "trigenys-sandbox-precis";
  revenueMinor = 140;
  requests = 0;

  async request<T = unknown>(request: ProviderHttpRequest): Promise<ProviderHttpResponse<T>> {
    this.requests++;
    assert.equal(request.method, "GET");
    assert.match(request.url, /^https:\/\/sandbox\.fapshi\.com\/payment-status\//);
    const providerReference = decodeURIComponent(request.url.split("/").at(-1) ?? "");
    const entry = this.responses.get(providerReference);
    if (!entry) {
      return { status: 404, body: { message: "missing" } as T };
    }
    return {
      status: 200,
      body: {
        transId: providerReference,
        transType: "Collection",
        status: this.providerStatus,
        serviceName: this.serviceName,
        externalId: entry.externalId,
        amount: entry.amount,
        revenue: this.revenueMinor
      } as T
    };
  }
}

test("Fapshi authenticated status -> payment/ledger/outbox is one SQL transaction", {
  skip: url ? false : "POSTGRES_TEST_URL not configured"
}, async t => {
  const pool = new Pool({ connectionString: url!, max: 10 });
  const other = new Pool({ connectionString: url!, max: 10 });
  try {
    await migrate(pool);
    const suffix = randomUUID();
    const projectId = `precis-atomic-${suffix}`;
    const merchantId = `merchant-atomic-${suffix}`;
    const otherProjectId = `other-atomic-${suffix}`;
    await pool.query(
      "INSERT INTO payment_projects(id,name,status) VALUES($1,'Precis test','active'),($2,'Other','active')",
      [projectId, otherProjectId]
    );
    await pool.query(
      `INSERT INTO payment_merchants (id,project_id,display_name,country,status)
       VALUES($1,$2,'Precis Merchant','CM','active')`,
      [merchantId, projectId]
    );

    const paymentService = new PaymentService({
      persistence: new PostgresPaymentPersistence(pool)
    });
    const stub = new StatusStub();
    const connector = new FapshiHostedConnector({
      client: new FapshiHostedClient({
        httpClient: stub,
        getCredentials: async () => ({
          apiuser: "test-sandbox-apiuser",
          apikey: "test-sandbox-apikey"
        })
      }),
      projectId,
      merchantId,
      expectedServiceName: stub.serviceName
    });
    const makeCoordinator = (connection: Pool) => new FapshiSandboxConfirmation({
      pool: connection, connector, projectId, merchantId,
      expectedServiceName: "trigenys-sandbox-precis"
    });
    const firstCoordinator = makeCoordinator(pool);
    const secondCoordinator = makeCoordinator(other);
    let nextOrder = 0;

    async function createBoundPayment() {
      const index = ++nextOrder;
      const reference = `purchase-${suffix}-${index}`;
      const created = await paymentService.createPayment({
        projectId, merchantId, externalReference: reference,
        amount: createMoney(150, "XAF"), channel: "mobile_money",
        idempotencyKey: `idem-${reference}`
      });
      assert.equal(created.ok, true);
      if (!created.ok) throw new Error("Failed to set up payment.");
      const providerReference = `fapshi-${suffix}-${index}`;
      const bound = await paymentService.bindProviderReference({
        paymentId: created.value.payment.id,
        provider: "fapshi", environment: "sandbox", providerPaymentReference: providerReference
      });
      assert.equal(bound.ok, true);
      stub.responses.set(providerReference, { externalId: reference, amount: 150 });
      return { paymentId: created.value.payment.id, providerReference, reference };
    }

    async function state(paymentId: string) {
      const payment = await pool.query<{ status: string }>(
        "SELECT status FROM payment_intents WHERE id=$1",
        [paymentId]
      );
      const ledger = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM payment_ledger_entries WHERE payment_id=$1",
        [paymentId]
      );
      const transitions = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM payment_transitions WHERE payment_id=$1",
        [paymentId]
      );
      const outbox = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM payment_outbox WHERE payment_id=$1",
        [paymentId]
      );
      return {
        status: payment.rows[0]?.status,
        ledger: ledger.rows[0]?.n,
        transitions: transitions.rows[0]?.n,
        outbox: outbox.rows[0]?.n
      };
    }

    await t.test("concurrent verification creates one business effect, replay survives restart", async () => {
      const { paymentId } = await createBoundPayment();
      const confirmations = await Promise.all([
        firstCoordinator.confirm(paymentId), secondCoordinator.confirm(paymentId),
        firstCoordinator.confirm(paymentId), secondCoordinator.confirm(paymentId)
      ]);
      assert.equal(new Set(confirmations.map(r => r.outboxId)).size, 1);
      assert.equal(new Set(confirmations.map(r => r.ledgerBatchId)).size, 1);
      assert.equal(confirmations.filter(r => !r.replayed).length, 1);
      assert.deepEqual(await state(paymentId), {
        status: "succeeded", ledger: 3, transitions: 2, outbox: 1
      });
      const replay = await makeCoordinator(other).confirm(paymentId);
      assert.equal(replay.replayed, true);
      const entries = await new LedgerService({
        persistence: new PostgresLedgerPersistence(other)
      }).listEntries({ projectId, merchantId, paymentId });
      assert.deepEqual(entries.map(entry => entry.kind).sort(),
        ["merchant_share", "payment_gross", "provider_fee"]);
      const outbox = await pool.query<{ payload: Record<string, unknown> }>(
        "SELECT payload FROM payment_outbox WHERE payment_id=$1",
        [paymentId]
      );
      assert.equal(outbox.rows[0]?.payload.eventType, "payment.confirmed");
      assert.equal(Object.hasOwn(outbox.rows[0]?.payload ?? {}, "pages"), false);
      assert.equal(Object.hasOwn(outbox.rows[0]?.payload ?? {}, "credits"), false);
    });

    await t.test("unverified, FAILED or mismatched collection never generates effects", async () => {
      const { paymentId, providerReference } = await createBoundPayment();
      stub.providerStatus = "FAILED";
      await assert.rejects(firstCoordinator.confirm(paymentId), /does not match/);
      assert.deepEqual(await state(paymentId), {
        status: "created", ledger: 0, transitions: 1, outbox: 0
      });
      stub.providerStatus = "SUCCESSFUL";
      stub.serviceName = "wrong-service";
      // The connector rejects this before the transactional coordinator runs.
      await assert.rejects(firstCoordinator.confirm(paymentId), /status verification failed: provider_rejected/);
      stub.serviceName = "trigenys-sandbox-precis";
      stub.responses.set(providerReference, { externalId: "other-purchase", amount: 150 });
      await assert.rejects(firstCoordinator.confirm(paymentId), /does not match/);
      stub.responses.set(providerReference, { externalId: `purchase-${suffix}-2`, amount: 200 });
      await assert.rejects(firstCoordinator.confirm(paymentId), /does not match/);
      assert.deepEqual(await state(paymentId), {
        status: "created", ledger: 0, transitions: 1, outbox: 0
      });
      stub.responses.set(providerReference, { externalId: `purchase-${suffix}-2`, amount: 150 });
    });

    await t.test("conflicting pre-existing financial evidence rolls back status and outgoing notification", async () => {
      const { paymentId, providerReference } = await createBoundPayment();
      const journal = new LedgerService({
        persistence: new PostgresLedgerPersistence(pool)
      });
      const preSeed = await journal.recordPaymentBreakdown({
        projectId, merchantId, paymentId,
        sourceKey: `fapshi:${paymentId}:confirmed:v1`,
        gross: createMoney(150, "XAF"),
        merchantShare: createMoney(120, "XAF"),
        providerFee: createMoney(30, "XAF"),
        provider: "fapshi", providerReference,
        occurredAt: "2026-10-19T00:00:00.000Z",
        metadata: {
          providerStatus: "SUCCESSFUL", serviceName: "trigenys-sandbox-precis"
        }
      });
      assert.equal(preSeed.ok, true);
      await assert.rejects(firstCoordinator.confirm(paymentId), /Financial evidence conflict/);
      assert.deepEqual(await state(paymentId), {
        status: "created", ledger: 3, transitions: 1, outbox: 0
      });
    });

    await t.test("outbox collision also rolls back payment and journal", async () => {
      const { paymentId } = await createBoundPayment();
      await pool.query(
        `INSERT INTO payment_outbox
           (id,project_id,payment_id,effect_key,destination,payload)
         VALUES($1,$2,$3,$4,'precis-payment-events',$5::jsonb)`,
        [randomUUID(), projectId, paymentId,
          `confirmed-${paymentId}`, JSON.stringify({ eventType: "incorrect" })]
      );
      await assert.rejects(firstCoordinator.confirm(paymentId), /Outbox effect key conflict/);
      assert.deepEqual(await state(paymentId), {
        status: "created", ledger: 0, transitions: 1, outbox: 1
      });
    });

    await t.test("foreign project and non-active merchant are rejected", async () => {
      const { paymentId } = await createBoundPayment();
      const foreignCoordinator = new FapshiSandboxConfirmation({
        pool, connector, projectId: otherProjectId, merchantId,
        expectedServiceName: "trigenys-sandbox-precis"
      });
      await assert.rejects(foreignCoordinator.confirm(paymentId), /not found/);
      await pool.query("UPDATE payment_merchants SET status='disabled' WHERE id=$1", [merchantId]);
      await assert.rejects(firstCoordinator.confirm(paymentId), /not active/);
      await pool.query("UPDATE payment_merchants SET status='active' WHERE id=$1", [merchantId]);
      assert.deepEqual(await state(paymentId), {
        status: "created", ledger: 0, transitions: 1, outbox: 0
      });
    });
  } finally {
    await Promise.all([pool.end(), other.end()]);
  }
});
