/**
 * Isolated deployed test harness. Never imported by the real inbox entrypoint.
 * No PSP HTTP traffic or real credentials: the provider transport is simulated.
 * Only fixed test identities, amounts and references are accepted.
 */
import { createHash } from "node:crypto";
import { Pool } from "pg";
import { hasNonEmptyBody, isInternalAuthorized } from "../../src/cloudflare/inbox-runtime.js";
import { createMoney } from "../../src/domain/money.js";
import { PaymentService } from "../../src/payments/service.js";
import type { ProviderHttpClient } from "../../src/providers/http.js";
import { PostgresMessageStore } from "../../src/storage/postgres/durable-messages.js";
import { PostgresPaymentPersistence } from "../../src/storage/postgres/payment-persistence.js";
import { createSandboxInboxWorker } from "../../src/worker/runtime.js";

const projectId = "cloudflare-contract-test";
const merchantId = "cloudflare-contract-merchant";
const serviceName = "cloudflare-contract-simulated-service";
const reference = "cf_contract_simulated_transaction_v1";
const externalId = "cf_contract_simulated_order_v1";
const transport: ProviderHttpClient = {
  async request<T>(request: import("../../src/providers/http.js").ProviderHttpRequest) {
    if (request.method !== "GET" ||
        request.url !== `https://sandbox.fapshi.com/payment-status/${reference}`) {
      throw new Error("CONTRACT_TRANSPORT_REJECTED");
    }
    return { status: 200, body: {
      transId: reference, externalId, amount: 150, revenue: 140,
      status: "SUCCESSFUL", transType: "Collection", serviceName
    } as T };
  }
};

function json(status: number, data: unknown) {
  return Response.json(data, { status, headers: { "cache-control": "no-store" } });
}

export default {
  async fetch(request: Request, env: PaymentContractEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "POST" || !["/setup", "/drain", "/replay", "/audit"].includes(path)) {
      return json(404, { error: "NOT_FOUND" });
    }
    if (!isInternalAuthorized(request, env.PAYMENT_SANDBOX_INTERNAL_TOKEN)) {
      return json(401, { error: "UNAUTHORIZED" });
    }
    if (await hasNonEmptyBody(request) || new URL(request.url).search) {
      return json(400, { error: "BODY_OR_QUERY_NOT_ALLOWED" });
    }
    const pool = new Pool({ connectionString: env.HYPERDRIVE.connectionString,
      max: 2, connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 7000 });
    try {
      const payments = new PaymentService({ persistence: new PostgresPaymentPersistence(pool) });
      if (path === "/setup") {
        const created = await payments.createPayment({
          projectId, merchantId, externalReference: externalId,
          amount: createMoney(150, "XAF"), channel: "mobile_money",
          idempotencyKey: "cf_contract_simulated_order_v1"
        });
        if (!created.ok) throw new Error("CONTRACT_SETUP_FAILED");
        const bound = await payments.bindProviderReference({
          paymentId: created.value.payment.id, provider: "fapshi",
          environment: "sandbox", providerPaymentReference: reference
        });
        if (!bound.ok) throw new Error("CONTRACT_BINDING_FAILED");
        const payload = { transId: reference, status: "SUCCESSFUL", transType: "Collection", serviceName };
        const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
        const inbox = await new PostgresMessageStore(pool).recordInbox({
          provider: "fapshi", environment: "sandbox", providerReference: reference,
          eventFingerprint: digest, payloadDigest: digest, payload
        });
        return json(200, { simulatedProvider: true, paymentId: created.value.payment.id, inboxReplayed: inbox.replayed });
      }
      if (path === "/drain") {
        const worker = createSandboxInboxWorker(pool, {
          projectId, merchantId, serviceName, apiuser: "simulated", apikey: "simulated"
        }, transport);
        return json(200, { simulatedProvider: true, ...await worker.runBatch(1) });
      }
      if (path === "/replay") {
        // A duplicate SUCCESSFUL callback with a distinct notification fingerprint
        // must still produce a single financial effect for the existing payment.
        const payload = { transId: reference, status: "SUCCESSFUL", transType: "Collection", serviceName };
        const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
        await new PostgresMessageStore(pool).recordInbox({
          provider: "fapshi", environment: "sandbox", providerReference: reference,
          eventFingerprint: createHash("sha256").update("contract-replay-v1").digest("hex"),
          payloadDigest: digest, payload
        });
        return json(200, { simulatedProvider: true, replayQueued: true });
      }
      const audit = await pool.query(
        `SELECT p.status,
          (SELECT COUNT(*)::int FROM payment_ledger_batches b WHERE b.project_id=p.project_id) AS ledger_batches,
          (SELECT COUNT(*)::int FROM payment_outbox o WHERE o.payment_id=p.id) AS outbox_messages,
          (SELECT COUNT(*)::int FROM payment_webhook_inbox i
            WHERE i.provider_reference=$3 AND i.status='processed') AS processed_inbox
         FROM payment_intents p WHERE p.project_id=$1 AND p.external_reference=$2`,
        [projectId, externalId, reference]
      );
      return json(200, { simulatedProvider: true, audit: audit.rows[0] ?? null });
    } catch {
      return json(503, { error: "CONTRACT_TEST_FAILED" });
    } finally {
      await pool.end().catch(() => undefined);
    }
  }
};
