import assert from "node:assert/strict";
import test from "node:test";
import type { SecretMaterial } from "../src/security/secrets.js";
import {
  FlutterwaveV3WebhookAdapter
} from "../src/providers/flutterwave/webhook.js";

const secret: SecretMaterial = {
  reference: {
    id: "flw-webhook-v1",
    environment: "sandbox",
    purpose: "provider_webhook",
    version: 1
  },
  value: "dummy-flutterwave-webhook-hash",
  status: "active",
  activatedAt: "2026-10-04T18:00:00.000Z"
};

function request(body: unknown, signature = secret.value) {
  return {
    provider: "flutterwave-v3",
    environment: "sandbox" as const,
    headers: {
      "verif-hash": signature
    },
    rawBody: Buffer.from(JSON.stringify(body)),
    receivedAt: "2026-10-04T18:01:00.000Z"
  };
}

test("Flutterwave v3 webhook verifier accepts only matching verif-hash", async () => {
  const adapter = new FlutterwaveV3WebhookAdapter();

  const valid = await adapter.verify(
    request({ event: "charge.completed", data: {} }),
    [secret]
  );
  assert.equal(valid.ok, true);

  const invalid = await adapter.verify(
    request({ event: "charge.completed", data: {} }, "wrong"),
    [secret]
  );
  assert.equal(invalid.ok, false);
  if (invalid.ok) return;

  assert.equal(invalid.error.code, "SIGNATURE_INVALID");
});

test("Flutterwave v3 charge.completed normalizes without provider-specific statuses", async () => {
  const adapter = new FlutterwaveV3WebhookAdapter();
  const raw = request({
    event: "charge.completed",
    data: {
      id: 98765,
      tx_ref: "zamari-payment-1",
      flw_ref: "FLW-MOCK-98765",
      amount: 50000,
      currency: "XAF",
      status: "successful",
      payment_type: "mobilemoneyxaf",
      created_at: "2026-10-04T18:00:30.000Z"
    }
  });

  const verification = await adapter.verify(raw, [secret]);
  assert.equal(verification.ok, true);
  if (!verification.ok) return;

  const event = await adapter.normalize(raw, verification);

  assert.equal(event.provider, "flutterwave-v3");
  assert.equal(event.providerPaymentReference, "zamari-payment-1");
  assert.equal(event.status, "succeeded");
  assert.equal(event.eventId, "charge.completed:98765:successful");
  assert.equal(event.occurredAt, "2026-10-04T18:00:30.000Z");
  assert.match(event.payloadDigest ?? "", /^[a-f0-9]{64}$/);
});

test("unsupported Flutterwave statuses fail instead of being guessed", async () => {
  const adapter = new FlutterwaveV3WebhookAdapter();
  const raw = request({
    event: "charge.completed",
    data: {
      id: 98765,
      tx_ref: "zamari-payment-1",
      status: "mystery"
    }
  });

  await assert.rejects(
    () => adapter.normalize(raw, {
      ok: true,
      matchedSecretReferenceId: secret.reference.id
    }),
    /Unsupported Flutterwave transaction status/
  );
});
