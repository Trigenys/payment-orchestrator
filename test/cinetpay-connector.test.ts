import assert from "node:assert/strict";
import test from "node:test";
import { createMoney } from "../src/domain/money.js";
import {
  CinetPayCheckoutClient,
  CinetPayV2Connector,
  cinetPayCapabilityProfile
} from "../src/providers/cinetpay/index.js";
import type {
  ProviderHttpClient,
  ProviderHttpRequest,
  ProviderHttpResponse
} from "../src/providers/http.js";
import { evaluateCapability } from "../src/providers/capabilities.js";
import { runProviderContractSuite } from "./support/provider-contract.js";

class StubHttpClient implements ProviderHttpClient {
  readonly requests: ProviderHttpRequest[] = [];

  async request<T = unknown>(
    request: ProviderHttpRequest
  ): Promise<ProviderHttpResponse<T>> {
    this.requests.push(request);

    if (
      request.method === "POST" &&
      request.url === "https://api-checkout.cinetpay.com/v2/payment"
    ) {
      return {
        status: 200,
        body: {
          code: "201",
          message: "CREATED",
          description: "Transaction created with success",
          data: {
            payment_token: "cp-token-1",
            payment_url: "https://checkout.cinetpay.com/payment/cp-token-1"
          },
          api_response_id: "api-response-1"
        } as T
      };
    }

    if (
      request.method === "POST" &&
      request.url === "https://api-checkout.cinetpay.com/v2/payment/check"
    ) {
      const body = request.body as {
        transaction_id?: string;
      };

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
            description: "Payment",
            metadata: null,
            operator_id: "OMCM-123",
            payment_date: "2026-10-04 21:30:00",
            fund_availability_date: "2026-10-06 00:00:00"
          },
          api_response_id: body.transaction_id ?? "missing"
        } as T
      };
    }

    return {
      status: 500,
      body: {
        code: "500",
        message: "unexpected request"
      } as T
    };
  }
}

function fixture() {
  const http = new StubHttpClient();
  const client = new CinetPayCheckoutClient({
    httpClient: http,
    getCredentials: async () => ({
      apiKey: "dummy-cinetpay-api-key",
      siteId: "123456"
    }),
    userAgent: "Trigenys-Payment-Orchestrator-Test"
  });

  let id = 0;
  const connector = new CinetPayV2Connector({
    client,
    notifyUrl: "https://payments.example.com/webhooks/cinetpay",
    now: () => "2026-10-04T21:30:00.000Z",
    newId: () => `id-${++id}`
  });

  return { http, client, connector };
}

const supportedContext = {
  projectId: "project-zamari",
  environment: "live" as const,
  country: "CM",
  currency: "XAF"
};

runProviderContractSuite("CinetPayV2Connector", {
  createConnector: () => fixture().connector,
  supportedContext,
  unsupportedContext: {
    projectId: "project-zamari",
    environment: "sandbox",
    country: "CM",
    currency: "XAF"
  },
  collectionChannel: "mobile_money",
  marketplaceAccountsExpected: "unsupported"
});

test("CinetPay Cameroon public capabilities do not claim marketplace support", () => {
  const collect = evaluateCapability(
    cinetPayCapabilityProfile,
    "collect",
    supportedContext
  );
  const marketplace = evaluateCapability(
    cinetPayCapabilityProfile,
    "marketplace_accounts",
    supportedContext
  );
  const split = evaluateCapability(
    cinetPayCapabilityProfile,
    "split_payments",
    supportedContext
  );

  assert.equal(collect.supported, true);
  assert.equal(marketplace.supported, false);
  assert.equal(split.supported, false);
});

test("CinetPay initializes a real public Checkout v2 mobile-money request", async () => {
  const { http, connector } = fixture();

  const result = await connector.createPayment({
    projectId: "project-zamari",
    merchantId: "merchant-centre-a",
    externalReference: "zamari-payment-1",
    amount: createMoney(50_000, "XAF"),
    channel: "mobile_money",
    customer: {
      email: "learner@example.com",
      name: "Learner",
      phone: "237600000000"
    },
    redirectUrl: "https://zamari.example/payments/return"
  }, supportedContext);

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.providerReference, "zamari-payment-1");
  assert.equal(
    result.value.providerMetadata?.checkoutUrl,
    "https://checkout.cinetpay.com/payment/cp-token-1"
  );

  const request = http.requests[0]!;
  assert.equal(
    request.url,
    "https://api-checkout.cinetpay.com/v2/payment"
  );

  const body = request.body as Record<string, unknown>;
  assert.equal(body.transaction_id, "zamari-payment-1");
  assert.equal(body.amount, 50000);
  assert.equal(body.currency, "XAF");
  assert.equal(body.channels, "MOBILE_MONEY");
  assert.equal(
    body.notify_url,
    "https://payments.example.com/webhooks/cinetpay"
  );
  assert.equal(body.apikey, "dummy-cinetpay-api-key");
  assert.equal(body.site_id, "123456");
});

test("CinetPay enforces documented XAF amount constraints", async () => {
  const { connector } = fixture();

  const tooLow = await connector.createPayment({
    projectId: "project-zamari",
    merchantId: "merchant-centre-a",
    externalReference: "payment-low",
    amount: createMoney(95, "XAF"),
    channel: "mobile_money",
    customer: { email: "learner@example.com" },
    redirectUrl: "https://zamari.example/return"
  }, supportedContext);

  assert.equal(tooLow.ok, false);

  const notMultipleOfFive = await connector.createPayment({
    projectId: "project-zamari",
    merchantId: "merchant-centre-a",
    externalReference: "payment-bad-step",
    amount: createMoney(10_001, "XAF"),
    channel: "mobile_money",
    customer: { email: "learner@example.com" },
    redirectUrl: "https://zamari.example/return"
  }, supportedContext);

  assert.equal(notMultipleOfFive.ok, false);
  if (notMultipleOfFive.ok) return;
  assert.match(notMultipleOfFive.error.message, /multiples of 5/i);
});

test("CinetPay public checkout rejects split allocations instead of faking White Label", async () => {
  const { connector } = fixture();

  const result = await connector.createPayment({
    projectId: "project-zamari",
    merchantId: "merchant-centre-a",
    externalReference: "split-attempt",
    amount: createMoney(50_000, "XAF"),
    channel: "mobile_money",
    customer: { email: "learner@example.com" },
    redirectUrl: "https://zamari.example/return",
    allocations: [{
      providerAccountId: "merchant-provider-account",
      amount: createMoney(48_500, "XAF")
    }]
  }, supportedContext);

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "capability_unsupported");
});

test("CinetPay verification uses the authoritative payment check endpoint", async () => {
  const { http, connector } = fixture();

  const result = await connector.verifyPayment({
    externalReference: "zamari-payment-1"
  }, supportedContext);

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.status, "succeeded");
  assert.equal(result.value.providerReference, "zamari-payment-1");
  assert.deepEqual(result.value.amount, {
    amountMinor: 50000,
    currency: "XAF"
  });

  const request = http.requests[0]!;
  assert.equal(
    request.url,
    "https://api-checkout.cinetpay.com/v2/payment/check"
  );
  assert.deepEqual(request.body, {
    transaction_id: "zamari-payment-1",
    site_id: "123456",
    apikey: "dummy-cinetpay-api-key"
  });
});
