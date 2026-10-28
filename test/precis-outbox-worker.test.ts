import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  createPrecisSignedEvent, validatedPrecisEndpoint
} from "../src/notifications/precis-signed-event.js";
import { PrecisOutboxWorker } from "../src/worker/precis-outbox-worker.js";
import { readPrecisOutboxConfig } from "../src/worker/outbox-run-once.js";
import type { LeasedOutboxDelivery, PostgresMessageStore } from "../src/storage/postgres/durable-messages.js";

const secret = "precis-connection-secret-".padEnd(48, "x");
const delivery: LeasedOutboxDelivery = {
  id: "outbox-event-123", projectId: "precis-project", paymentId: "payment-123",
  destination: "precis-payment-events", effectKey: "confirmed-payment-123",
  attemptCount: 1, leaseToken: "lease-1",
  payload: {
    eventType: "payment.confirmed", projectId: "precis-project",
    merchantId: "precis-merchant", paymentId: "payment-123",
    externalReference: "precis-order-123", provider: "fapshi",
    providerReference: "psp-ref-123", currency: "XAF", amountMinor: 150
  }
};

test("Précis outbox signs the exact raw event, never grants pages or credits", () => {
  const { body, headers } = createPrecisSignedEvent(delivery, "sandbox", {
    keyId: "precis-sandbox-v1", secret
  }, 1770000000);
  const event = JSON.parse(body);
  assert.equal(event.environment, "sandbox");
  assert.equal(event.eventId, delivery.id);
  assert.equal(event.effectKey, delivery.effectKey);
  assert.equal(event.data.amountMinor, 150);
  assert.equal(Object.hasOwn(event, "pages"), false);
  assert.equal(Object.hasOwn(event.data, "credits"), false);
  const expected = createHmac("sha256", secret)
    .update(`v1\n1770000000\n${delivery.id}\n${body}`).digest("hex");
  assert.equal(headers["x-trigenys-signature"], `v1=${expected}`);
  assert.equal(headers["x-trigenys-key-id"], "precis-sandbox-v1");
  const replay = createPrecisSignedEvent(delivery, "sandbox", {
    keyId: "precis-sandbox-v1", secret
  }, 1770000001);
  assert.equal(JSON.parse(replay.body).eventId, delivery.id);
  assert.notEqual(replay.headers["x-trigenys-signature"], headers["x-trigenys-signature"]);
  assert.throws(() => createPrecisSignedEvent({
    ...delivery, payload: { ...delivery.payload, pages: 2 }
  }, "sandbox", { keyId: "precis-sandbox-v1", secret }, 1), /invalid financial evidence/i);
  assert.throws(() => createPrecisSignedEvent(delivery, "live", {
    keyId: "bad/key", secret
  }, 1), /Invalid signature/);
});

test("Précis delivery endpoint has fixed HTTPS path and Trigenys DNS", () => {
  assert.equal(validatedPrecisEndpoint(
    "https://precis-translator.trigenys.com/api/payments/orchestrator/events"
  ), "https://precis-translator.trigenys.com/api/payments/orchestrator/events");
  for (const endpoint of [
    "http://precis-translator.trigenys.com/api/payments/orchestrator/events",
    "https://precis-translator.trigenys.com.evil.test/api/payments/orchestrator/events",
    "https://127.0.0.1/api/payments/orchestrator/events",
    "https://precis-translator.trigenys.com@evil.test/api/payments/orchestrator/events",
    "https://precis-translator.trigenys.com/api/payments/orchestrator/events?redirect=x",
    "https://precis-translator.trigenys.com/other"
  ]) assert.throws(() => validatedPrecisEndpoint(endpoint), /fixed Trigenys/);
});

function fixture(overrides?: {
  readonly message?: LeasedOutboxDelivery;
  readonly verified?: boolean;
  readonly ack?: boolean;
  readonly httpStatus?: number;
  readonly throws?: boolean;
}) {
  const called = { verified: 0, requested: 0, ack: 0, retry: 0, claims: 0 };
  const msgs = overrides?.message ? [overrides.message] : [delivery];
  const store = {
    lease: async () => { called.claims++; return msgs; },
    acknowledge: async (id: string, token: string) => {
      assert.equal(id, delivery.id);
      assert.equal(token, delivery.leaseToken);
      called.ack++;
      return true;
    },
    retryOrQuarantine: async (_id: string, _token: string, code: string, _delay: number, max: number) => {
      called.retry++;
      assert.match(code, /^[A-Z_]+$/);
      return max === 1 ? "dead_letter" as const : "retry_scheduled" as const;
    }
  } as unknown as Pick<PostgresMessageStore, "lease" | "acknowledge" | "retryOrQuarantine">;

  const worker = new PrecisOutboxWorker({
    store,
    projectId: delivery.projectId, environment: "sandbox",
    signingKey: { keyId: "precis-sandbox-v1", secret },
    endpoint: "https://precis-translator.trigenys.com/api/payments/orchestrator/events",
    nowSeconds: () => 1770000000,
    isVerifiedPayment: async () => { called.verified++; return overrides?.verified !== false; },
    fetchImpl: async (url, init) => {
      called.requested++;
      assert.equal(url, "https://precis-translator.trigenys.com/api/payments/orchestrator/events");
      assert.equal(init?.method, "POST");
      assert.equal(init?.redirect, "error");
      assert.equal((init?.headers as Record<string,string>)["x-trigenys-event-id"], delivery.id);
      if (overrides?.throws) throw new Error("private network failure");
      return new Response(null, {
        status: overrides?.httpStatus ?? 204,
        headers: {
          "x-trigenys-event-ack": overrides?.ack === false ? "different-event" : delivery.id
        }
      });
    }
  });
  return { worker, called };
}

test("HTTP 204 with matching durable receipt ACKs once", async () => {
  const f = fixture();
  assert.deepEqual(await f.worker.runBatch(), {
    claimed: 1, delivered: 1, retried: 0, deadLetter: 0, stale: 0
  });
  assert.deepEqual(f.called, { verified: 1, requested: 1, ack: 1, retry: 0, claims: 1 });
});

test("no ACK, HTTP 500, or network timeout do not mark delivered", async () => {
  for (const opt of [{ ack: false }, { httpStatus: 500 }, { throws: true }]) {
    const f = fixture(opt);
    const r = await f.worker.runBatch();
    assert.equal(r.retried, 1);
    assert.equal(f.called.ack, 0);
    assert.equal(f.called.retry, 1);
  }
});

test("unverified or malformed evidence cannot be delivered even with valid key", async () => {
  const a = fixture({ verified: false });
  assert.equal((await a.worker.runBatch()).deadLetter, 1);
  assert.equal(a.called.requested, 0);
  const b = fixture({ message: {
    ...delivery, payload: { ...delivery.payload, amountMinor: 70 }
  } });
  assert.equal((await b.worker.runBatch()).deadLetter, 1);
  assert.equal(b.called.requested, 0);
});

test("live and sandbox outbound notifications require isolated opt-in", () => {
  const env = {
    PAYMENT_SANDBOX_PROJECT_ID: "precis-project",
    PAYMENT_SANDBOX_DATABASE_URL: "postgresql://sandbox",
    PAYMENT_SANDBOX_PRECIS_EVENT_URL: "https://precis-translator.trigenys.com/api/payments/orchestrator/events",
    PAYMENT_SANDBOX_OUTBOX_KEY_ID: "sandbox-1",
    PAYMENT_SANDBOX_OUTBOX_HMAC_SECRET: secret
  };
  assert.throws(() => readPrecisOutboxConfig(env), /disabled/);
  const enabled = readPrecisOutboxConfig({ ...env, PAYMENT_SANDBOX_OUTBOX_ENABLED: "true" });
  assert.equal(enabled.environment, "sandbox");
  assert.equal(enabled.projectId, "precis-project");
  assert.throws(() => readPrecisOutboxConfig({
    ...env, PAYMENT_ENVIRONMENT: "live", PAYMENT_LIVE_OUTBOX_ENABLED: "true"
  }), /explicit rollout approval/);
});
