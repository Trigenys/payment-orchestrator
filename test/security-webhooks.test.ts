import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import test from "node:test";
import type { NormalizedProviderPaymentEvent } from "../src/payments/types.js";
import {
  InMemorySecretStore,
  ProviderCredentialResolver,
  type ProviderCredentialBinding,
  type SecretMaterial
} from "../src/security/secrets.js";
import {
  InMemoryWebhookCredentialRegistry,
  WebhookIngressService,
  type ProviderWebhookAdapter,
  type RawWebhookRequest,
  type WebhookVerificationResult
} from "../src/security/webhooks.js";

const webhookSecret: SecretMaterial = {
  reference: {
    id: "webhook-secret-v1",
    environment: "sandbox",
    purpose: "provider_webhook",
    version: 1
  },
  value: "dummy-webhook-secret-for-tests",
  status: "active",
  activatedAt: "2026-10-04T18:00:00.000Z"
};

const binding: ProviderCredentialBinding = {
  provider: "provider-a",
  environment: "sandbox",
  purpose: "provider_webhook",
  secretReferences: [webhookSecret.reference]
};

function signature(rawBody: Uint8Array, secret: string): string {
  return createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex");
}

class TestWebhookAdapter implements ProviderWebhookAdapter {
  readonly provider = "provider-a";
  verifyCalls = 0;
  normalizeCalls = 0;

  async verify(
    request: RawWebhookRequest,
    secrets: readonly SecretMaterial[]
  ): Promise<WebhookVerificationResult> {
    this.verifyCalls += 1;
    const supplied = request.headers["x-signature"];
    if (typeof supplied !== "string") {
      return {
        ok: false,
        error: {
          code: "SIGNATURE_MISSING",
          message: "signature missing"
        }
      };
    }

    for (const secret of secrets) {
      const expected = signature(request.rawBody, secret.value);
      const left = Buffer.from(supplied, "hex");
      const right = Buffer.from(expected, "hex");

      if (
        left.length === right.length &&
        left.length > 0 &&
        timingSafeEqual(left, right)
      ) {
        return {
          ok: true,
          matchedSecretReferenceId: secret.reference.id
        };
      }
    }

    return {
      ok: false,
      error: {
        code: "SIGNATURE_INVALID",
        message: "signature invalid"
      }
    };
  }

  async normalize(
    request: RawWebhookRequest
  ): Promise<NormalizedProviderPaymentEvent> {
    this.normalizeCalls += 1;

    return {
      provider: request.provider,
      environment: request.environment,
      eventId: "event-1",
      providerPaymentReference: "provider-payment-1",
      status: "succeeded",
      occurredAt: "2026-10-04T18:00:00.000Z"
    };
  }
}

function requestWithSignature(value: string): RawWebhookRequest {
  const rawBody = Buffer.from('{"event":"payment.success"}');

  return {
    provider: "provider-a",
    environment: "sandbox",
    headers: {
      "x-signature": value
    },
    rawBody,
    receivedAt: "2026-10-04T18:00:01.000Z",
    sourceIp: "127.0.0.1"
  };
}

test("invalid signatures are rejected before normalization or domain processing", async () => {
  const adapter = new TestWebhookAdapter();
  let domainCalls = 0;

  const service = new WebhookIngressService({
    adapter,
    credentialRegistry: new InMemoryWebhookCredentialRegistry([binding]),
    credentialResolver: new ProviderCredentialResolver(
      new InMemorySecretStore([webhookSecret])
    ),
    paymentEventSink: {
      async ingestProviderEvent() {
        domainCalls += 1;
        throw new Error("must not be called");
      }
    }
  });

  const result = await service.ingest(
    requestWithSignature("00".repeat(32))
  );

  assert.equal(result.ok, false);
  if (result.ok) return;

  assert.equal(result.error.code, "INVALID_SIGNATURE");
  assert.equal(adapter.verifyCalls, 1);
  assert.equal(adapter.normalizeCalls, 0);
  assert.equal(domainCalls, 0);
});

test("verified raw-body signature reaches normalized payment domain once", async () => {
  const adapter = new TestWebhookAdapter();
  const rawBody = Buffer.from('{"event":"payment.success"}');
  let domainCalls = 0;

  const service = new WebhookIngressService({
    adapter,
    credentialRegistry: new InMemoryWebhookCredentialRegistry([binding]),
    credentialResolver: new ProviderCredentialResolver(
      new InMemorySecretStore([webhookSecret])
    ),
    paymentEventSink: {
      async ingestProviderEvent(event) {
        domainCalls += 1;
        assert.equal(event.provider, "provider-a");
        assert.equal(event.environment, "sandbox");
        assert.equal(event.receivedAt, "2026-10-04T18:00:01.000Z");

        return {
          ok: true,
          value: {
            receipt: {
              key: "provider-a:event-1",
              fingerprint: "fingerprint",
              provider: "provider-a",
              environment: "sandbox",
              eventId: "event-1",
              providerPaymentReference: "provider-payment-1",
              targetStatus: "succeeded",
              outcome: "unmatched",
              occurredAt: "2026-10-04T18:00:00.000Z",
              receivedAt: "2026-10-04T18:00:01.000Z"
            },
            replayed: false
          }
        };
      }
    }
  });

  const request: RawWebhookRequest = {
    provider: "provider-a",
    environment: "sandbox",
    headers: {
      "x-signature": signature(rawBody, webhookSecret.value)
    },
    rawBody,
    receivedAt: "2026-10-04T18:00:01.000Z",
    sourceIp: "127.0.0.1"
  };

  const result = await service.ingest(request);

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.matchedSecretReferenceId, "webhook-secret-v1");
  assert.equal(adapter.normalizeCalls, 1);
  assert.equal(domainCalls, 1);
});

test("webhook credential environment mismatches fail before verification", async () => {
  const adapter = new TestWebhookAdapter();

  const service = new WebhookIngressService({
    adapter,
    credentialRegistry: new InMemoryWebhookCredentialRegistry([{
      ...binding,
      environment: "live"
    }]),
    credentialResolver: new ProviderCredentialResolver(
      new InMemorySecretStore([webhookSecret])
    ),
    paymentEventSink: {
      async ingestProviderEvent() {
        throw new Error("must not be called");
      }
    }
  });

  const result = await service.ingest(requestWithSignature("00".repeat(32)));

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "CREDENTIAL_BINDING_NOT_FOUND");
  assert.equal(adapter.verifyCalls, 0);
});


test("oversized webhook bodies are rejected before verification", async () => {
  const adapter = new TestWebhookAdapter();

  const service = new WebhookIngressService({
    adapter,
    credentialRegistry: new InMemoryWebhookCredentialRegistry([binding]),
    credentialResolver: new ProviderCredentialResolver(
      new InMemorySecretStore([webhookSecret])
    ),
    paymentEventSink: {
      async ingestProviderEvent() {
        throw new Error("must not be called");
      }
    },
    maxBodyBytes: 4
  });

  const result = await service.ingest({
    ...requestWithSignature("00".repeat(32)),
    rawBody: Buffer.from("too-large")
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "BODY_TOO_LARGE");
  assert.equal(adapter.verifyCalls, 0);
});
