import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  CinetPayCheckoutClient,
  CinetPayV2WebhookAdapter
} from "../src/providers/cinetpay/index.js";
import type {
  ProviderHttpClient,
  ProviderHttpRequest,
  ProviderHttpResponse
} from "../src/providers/http.js";
import type { SecretMaterial } from "../src/security/secrets.js";

class StubHttpClient implements ProviderHttpClient {
  readonly requests: ProviderHttpRequest[] = [];

  async request<T = unknown>(
    request: ProviderHttpRequest
  ): Promise<ProviderHttpResponse<T>> {
    this.requests.push(request);

    return {
      status: 200,
      body: {
        code: "00",
        message: "SUCCES",
        data: {
          amount: "50000",
          currency: "XAF",
          status: "ACCEPTED",
          payment_method: "OMCM",
          operator_id: "OMCM-123",
          payment_date: "2026-10-04 21:30:00",
          fund_availability_date: "2026-10-06 00:00:00"
        },
        api_response_id: "verify-1"
      } as T
    };
  }
}

const webhookSecret: SecretMaterial = {
  reference: {
    id: "cinetpay-webhook-v1",
    environment: "live",
    purpose: "provider_webhook",
    version: 1
  },
  value: "dummy-cinetpay-webhook-secret",
  status: "active",
  activatedAt: "2026-10-04T21:00:00.000Z"
};

const orderedFields = [
  ["cpm_site_id", "123456"],
  ["cpm_trans_id", "zamari-payment-1"],
  ["cpm_trans_date", "2026-10-04 21:30:00"],
  ["cpm_amount", "50000"],
  ["cpm_currency", "XAF"],
  ["signature", "provider-signature-field"],
  ["payment_method", "OMCM"],
  ["cel_phone_num", "600000000"],
  ["cpm_phone_prefixe", "237"],
  ["cpm_language", "fr"],
  ["cpm_version", "V4"],
  ["cpm_payment_config", "Single"],
  ["cpm_page_action", "Payment"],
  ["cpm_custom", ""],
  ["cpm_designation", "Payment"],
  ["cpm_error_message", ""]
] as const;

function rawBody(): Buffer {
  const params = new URLSearchParams();
  for (const [key, value] of orderedFields) {
    params.set(key, value);
  }
  return Buffer.from(params.toString());
}

function xToken(): string {
  const signed = orderedFields
    .map(([, value]) => value)
    .join("");

  return createHmac("sha256", webhookSecret.value)
    .update(signed)
    .digest("hex");
}

function fixture() {
  const http = new StubHttpClient();
  const client = new CinetPayCheckoutClient({
    httpClient: http,
    getCredentials: async () => ({
      apiKey: "dummy-cinetpay-api-key",
      siteId: "123456"
    })
  });
  const adapter = new CinetPayV2WebhookAdapter({ client });

  return { http, adapter };
}

function request(token = xToken()) {
  return {
    provider: "cinetpay-v2",
    environment: "live" as const,
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-token": token
    },
    rawBody: rawBody(),
    receivedAt: "2026-10-04T21:31:00.000Z"
  };
}

test("CinetPay x-token HMAC is verified from the documented field order", async () => {
  const { adapter } = fixture();

  const valid = await adapter.verify(request(), [webhookSecret]);
  assert.equal(valid.ok, true);

  const invalid = await adapter.verify(
    request("00".repeat(32)),
    [webhookSecret]
  );
  assert.equal(invalid.ok, false);
  if (invalid.ok) return;

  assert.equal(invalid.error.code, "SIGNATURE_INVALID");
});

test("CinetPay notification normalization calls authoritative transaction verification", async () => {
  const { http, adapter } = fixture();
  const req = request();

  const verified = await adapter.verify(req, [webhookSecret]);
  assert.equal(verified.ok, true);
  if (!verified.ok) return;

  const event = await adapter.normalize(req, verified);

  assert.equal(event.provider, "cinetpay-v2");
  assert.equal(event.providerPaymentReference, "zamari-payment-1");
  assert.equal(event.status, "succeeded");
  assert.match(event.eventId, /^[a-f0-9]{64}$/);

  assert.equal(http.requests.length, 1);
  assert.equal(
    http.requests[0]?.url,
    "https://api-checkout.cinetpay.com/v2/payment/check"
  );
});

test("duplicate CinetPay callbacks for the same authoritative state get the same synthetic event id", async () => {
  const firstFixture = fixture();
  const secondFixture = fixture();

  const first = await firstFixture.adapter.normalize(
    request(),
    {
      ok: true,
      matchedSecretReferenceId: webhookSecret.reference.id
    }
  );
  const second = await secondFixture.adapter.normalize(
    request(),
    {
      ok: true,
      matchedSecretReferenceId: webhookSecret.reference.id
    }
  );

  assert.equal(first.eventId, second.eventId);
});

test("CinetPay callback status text is never trusted as authoritative payment state", async () => {
  const { adapter } = fixture();
  const params = new URLSearchParams(Buffer.from(rawBody()).toString("utf8"));
  params.set("cpm_error_message", "REFUSED");

  const modifiedRequest = {
    ...request(),
    rawBody: Buffer.from(params.toString())
  };

  const event = await adapter.normalize(
    modifiedRequest,
    {
      ok: true,
      matchedSecretReferenceId: webhookSecret.reference.id
    }
  );

  assert.equal(event.status, "succeeded");
});
