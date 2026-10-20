import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { reserveFapshiStatusRead } from "../src/api/fapshi-status-budget.js";
import { createMoney } from "../src/domain/money.js";
import { PaymentService } from "../src/payments/service.js";
import type { ProviderEnvironment } from "../src/providers/capabilities.js";
import { FapshiHostedClient } from "../src/providers/fapshi/client.js";
import { FapshiHostedConnector } from "../src/providers/fapshi/connector.js";
import type { ProviderHttpClient } from "../src/providers/http.js";
import { PostgresMessageStore } from "../src/storage/postgres/durable-messages.js";
import { FapshiConfirmation } from "../src/storage/postgres/fapshi-confirmation.js";
import { migrate } from "../src/storage/postgres/migrate.js";
import { PostgresPaymentPersistence } from "../src/storage/postgres/payment-persistence.js";
import { PostgresInboxWorkerStore } from "../src/worker/inbox-persistence.js";
import { createInboxWorker, isInboxSchemaReady } from "../src/worker/runtime.js";

const url = process.env.POSTGRES_TEST_URL;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

test("both environments share one financial pipeline while inbox, bindings and quotas stay isolated", {
  skip: url ? false : "POSTGRES_TEST_URL not configured"
}, async t => {
  const pool = new Pool({ connectionString: url!, max: 8 });
  const other = new Pool({ connectionString: url!, max: 8 });
  try {
    await migrate(pool);
    assert.equal(await isInboxSchemaReady(pool), true);
    const suffix = randomUUID();
    const projectId = `env-project-${suffix}`;
    const merchantId = `env-merchant-${suffix}`;
    // Deliberately collide service name, PSP reference and notification fingerprint
    // across both environments, even inside the same test database.
    const serviceName = `same-service-${suffix}`;
    const reference = `same-reference-${suffix}`;
    await pool.query("INSERT INTO payment_projects(id,name,status) VALUES($1,'Environment contract','active')", [projectId]);
    await pool.query(`INSERT INTO payment_merchants(id,project_id,display_name,country,status)
      VALUES($1,$2,'Environment merchant','CM','active')`, [merchantId, projectId]);
    const payments = new PaymentService({ persistence: new PostgresPaymentPersistence(pool) });
    const inbox = new PostgresMessageStore(pool);
    const ids = new Map<ProviderEnvironment, string>();
    const requests: string[] = [];
    const config = (environment: ProviderEnvironment) => ({
      environment, projectId, merchantId, serviceName,
      apiuser: `test-${environment}-user`, apikey: `test-${environment}-key`
    });
    const http: ProviderHttpClient = {
      async request<T>(request: import("../src/providers/http.js").ProviderHttpRequest) {
        const environment = request.url.startsWith("https://live.") ? "live" : "sandbox";
        assert.equal(request.url, `https://${environment}.fapshi.com/payment-status/${reference}`);
        assert.equal(request.method, "GET");
        assert.equal(request.headers?.apiuser, config(environment).apiuser);
        assert.equal(request.headers?.apikey, config(environment).apikey);
        requests.push(environment);
        return { status: 200, body: {
          transId: reference, transType: "Collection", status: "SUCCESSFUL", serviceName,
          externalId: `order-${environment}-${suffix}`, amount: 150, revenue: 140
        } as T };
      }
    };

    for (const environment of ["sandbox", "live"] as const) {
      const order = `order-${environment}-${suffix}`;
      const created = await payments.createPayment({
        projectId, merchantId, externalReference: order, idempotencyKey: order,
        amount: createMoney(150, "XAF"), channel: "mobile_money"
      });
      assert.equal(created.ok, true);
      if (!created.ok) throw new Error("Test setup failed");
      ids.set(environment, created.value.payment.id);
      assert.equal((await payments.bindProviderReference({
        paymentId: created.value.payment.id, provider: "fapshi", environment,
        providerPaymentReference: reference
      })).ok, true);
      assert.equal((await inbox.recordInbox({
        provider: "fapshi", environment, providerReference: reference,
        eventFingerprint: digest(reference), payloadDigest: digest(reference),
        payload: { transId: reference, status: "SUCCESSFUL", serviceName }
      })).replayed, false);
    }

    await t.test("wrong-environment confirmation is rejected before PSP access", async () => {
      const connector = new FapshiHostedConnector({
        client: new FapshiHostedClient({ environment: "live", httpClient: http,
          getCredentials: async () => config("live") }), projectId, merchantId, expectedServiceName: serviceName
      });
      const confirmation = new FapshiConfirmation({
        pool, environment: "live", projectId, merchantId, expectedServiceName: serviceName, connector
      });
      await assert.rejects(confirmation.confirm(ids.get("sandbox")!), /environment and service/);
      assert.equal(requests.length, 0);
    });

    await t.test("lease changes cannot acknowledge or retry another environment", async () => {
      const sandbox = new PostgresInboxWorkerStore(pool, serviceName, "sandbox");
      const live = new PostgresInboxWorkerStore(other, serviceName, "live");
      const lease = (await sandbox.claim(1))[0]!;
      assert.ok(lease);
      assert.equal(await live.complete(lease), false);
      assert.equal(await live.retry(lease, "TEST_RETRY", 1), "stale_lease");
      assert.equal(await live.deferRateLimit(lease), false);
      assert.equal(await sandbox.deferRateLimit(lease), true);
      await pool.query("UPDATE payment_webhook_inbox SET next_attempt_at=now() WHERE id=$1", [lease.id]);
    });

    await t.test("each worker confirms only its payment and duplicate observations have one financial effect", async () => {
      for (const environment of ["sandbox", "live"] as const) {
        const worker = createInboxWorker(pool, config(environment), http);
        assert.equal((await worker.runBatch(1)).processed, 1);
        assert.equal((await worker.runBatch(1)).claimed, 0);
        const audit = await payments.getPaymentAudit(ids.get(environment)!);
        assert.ok(audit.ok);
        if (audit.ok) assert.equal(audit.value.payment.status, "succeeded");
        if (environment === "sandbox") {
          const liveAudit = await payments.getPaymentAudit(ids.get("live")!);
          assert.ok(liveAudit.ok);
          if (liveAudit.ok) assert.equal(liveAudit.value.payment.status, "created");
        }
        await inbox.recordInbox({
          provider: "fapshi", environment, providerReference: reference,
          eventFingerprint: digest(reference + "duplicate"), payloadDigest: digest(reference),
          payload: { transId: reference, status: "SUCCESSFUL", serviceName }
        });
        assert.equal((await worker.runBatch(1)).processed, 1);
        const evidence = await pool.query<{ batches: number; outbox: number }>(
          `SELECT (SELECT count(*)::int FROM payment_ledger_batches WHERE payload->>'paymentId'=$1) AS batches,
           (SELECT count(*)::int FROM payment_outbox WHERE payment_id=$1) AS outbox`, [ids.get(environment)]
        );
        assert.deepEqual(evidence.rows[0], { batches: 1, outbox: 1 });
      }
      assert.deepEqual(requests, ["sandbox", "sandbox", "live", "live"]);
    });

    await t.test("the same reference has separate rolling-window budgets", async () => {
      const ref = `budget-env-${suffix}`;
      for (const environment of ["sandbox", "live"] as const) {
        const attempts = await Promise.all(Array.from({ length: 9 }, (_, i) =>
          reserveFapshiStatusRead(i % 2 ? pool : other, ref, environment)));
        assert.equal(attempts.filter(Boolean).length, 5);
      }
    });
  } finally {
    await Promise.all([pool.end(), other.end()]);
  }
});
