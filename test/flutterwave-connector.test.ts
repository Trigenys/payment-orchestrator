import assert from "node:assert/strict";
import test from "node:test";
import { createMoney } from "../src/domain/money.js";
import type { ProviderAccount } from "../src/domain/models.js";
import {
  FLUTTERWAVE_CM_MARKETPLACE_APPROVED,
  FlutterwaveV3Connector,
  flutterwaveCapabilityProfile
} from "../src/providers/flutterwave/index.js";
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

    if (request.method === "POST" && request.url.endsWith("/v3/subaccounts")) {
      return {
        status: 200,
        body: {
          status: "success",
          message: "Subaccount created",
          data: {
            id: 42,
            account_number: "10005000010449229105136",
            account_bank: "CM10005",
            full_name: "Centre Alpha",
            subaccount_id: "RS_TEST_CM_001",
            bank_name: "Test Bank Cameroon",
            country: "CM",
            split_type: "percentage",
            split_value: 0
          }
        } as T
      };
    }

    if (request.method === "POST" && request.url.endsWith("/v3/payments")) {
      return {
        status: 200,
        body: {
          status: "success",
          message: "Hosted Link",
          data: {
            link: "https://checkout.flutterwave.com/v3/hosted/pay/test-link"
          }
        } as T
      };
    }

    if (
      request.method === "GET" &&
      request.url.includes("/v3/transactions/verify_by_reference")
    ) {
      return {
        status: 200,
        body: {
          status: "success",
          message: "Transaction fetched successfully",
          data: {
            id: 98765,
            tx_ref: "zamari-payment-1",
            flw_ref: "FLW-MOCK-98765",
            amount: 50000,
            currency: "XAF",
            charged_amount: 50000,
            app_fee: 1000,
            merchant_fee: 0,
            status: "successful",
            payment_type: "mobilemoneyxaf",
            amount_settled: 49000
          }
        } as T
      };
    }

    return {
      status: 500,
      body: {
        status: "error",
        message: "unexpected test request",
        data: null
      } as T
    };
  }
}

const providerAccount: ProviderAccount = {
  id: "provider-account-1",
  merchantId: "merchant-1",
  provider: "flutterwave-v3",
  environment: "sandbox",
  externalAccountId: "RS_TEST_CM_001",
  status: "active",
  createdAt: "2026-10-04T18:00:00.000Z"
};

function connector(http = new StubHttpClient()) {
  let id = 0;

  return {
    http,
    connector: new FlutterwaveV3Connector({
      httpClient: http,
      getSecretKey: async () => "dummy-flutterwave-test-secret",
      providerAccounts: {
        async getById(idToFind) {
          return idToFind === providerAccount.id ? providerAccount : undefined;
        }
      },
      now: () => "2026-10-04T18:00:00.000Z",
      newId: () => `id-${++id}`
    })
  };
}

const supportedContext = {
  projectId: "project-zamari",
  environment: "sandbox" as const,
  country: "CM",
  currency: "XAF",
  commercialFeatures: [FLUTTERWAVE_CM_MARKETPLACE_APPROVED]
};

runProviderContractSuite("FlutterwaveV3Connector", {
  createConnector: () => connector().connector,
  supportedContext,
  unsupportedContext: {
    projectId: "project-zamari",
    environment: "sandbox",
    country: "CM",
    currency: "USD",
    commercialFeatures: [FLUTTERWAVE_CM_MARKETPLACE_APPROVED]
  }
});

test("marketplace capability is fail-closed until Cameroon approval is explicit", () => {
  const blocked = evaluateCapability(
    flutterwaveCapabilityProfile,
    "split_payments",
    {
      environment: "sandbox",
      country: "CM",
      currency: "XAF"
    }
  );

  assert.equal(blocked.supported, false);
  assert.ok(blocked.failures.some(
    (failure) => failure.code === "COMMERCIAL_FEATURE_REQUIRED"
  ));

  const approved = evaluateCapability(
    flutterwaveCapabilityProfile,
    "split_payments",
    {
      environment: "sandbox",
      country: "CM",
      currency: "XAF",
      commercialFeatures: [FLUTTERWAVE_CM_MARKETPLACE_APPROVED]
    }
  );

  assert.equal(approved.supported, true);
});

test("collection subaccount maps a generic bank settlement destination to Flutterwave v3", async () => {
  const fixture = connector();

  const result = await fixture.connector.createProviderAccount({
    merchantId: "merchant-1",
    displayName: "Centre Alpha",
    country: "CM",
    currency: "XAF",
    externalReference: "centre-alpha",
    settlementDestination: {
      type: "bank_account",
      country: "CM",
      currency: "XAF",
      bankCode: "CM10005",
      accountNumber: "10005000010449229105136"
    },
    contact: {
      email: "centre@example.com",
      phone: "237600000000"
    }
  }, supportedContext);

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.externalAccountId, "RS_TEST_CM_001");

  const request = fixture.http.requests[0]!;
  assert.equal(request.url, "https://api.flutterwave.com/v3/subaccounts");
  assert.deepEqual(request.body, {
    account_bank: "CM10005",
    account_number: "10005000010449229105136",
    business_name: "Centre Alpha",
    business_mobile: "237600000000",
    business_email: "centre@example.com",
    country: "CM",
    split_type: "percentage",
    split_value: 0
  });
});

test("mobile-money settlement destination is not mislabeled as Flutterwave split settlement support", async () => {
  const fixture = connector();

  const result = await fixture.connector.createProviderAccount({
    merchantId: "merchant-1",
    displayName: "Centre Alpha",
    country: "CM",
    currency: "XAF",
    externalReference: "centre-alpha",
    settlementDestination: {
      type: "mobile_money",
      country: "CM",
      currency: "XAF",
      network: "MTN",
      phoneNumber: "237600000000"
    },
    contact: {
      phone: "237600000000"
    }
  }, supportedContext);

  assert.equal(result.ok, false);
  if (result.ok) return;

  assert.equal(result.error.code, "invalid_request");
  assert.match(result.error.message, /bank-account settlement/i);
  assert.equal(fixture.http.requests.length, 0);
});

test("single-beneficiary split maps platform commission to a flat transaction charge", async () => {
  const fixture = connector();

  const result = await fixture.connector.createPayment({
    projectId: "project-zamari",
    merchantId: "merchant-1",
    providerAccountId: providerAccount.id,
    externalReference: "zamari-payment-1",
    amount: createMoney(50_000, "XAF"),
    channel: "mobile_money",
    customer: {
      email: "learner@example.com",
      name: "Learner"
    },
    redirectUrl: "https://zamari.example/payments/return",
    allocations: [{
      providerAccountId: providerAccount.id,
      amount: createMoney(48_500, "XAF")
    }]
  }, supportedContext);

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.providerReference, "zamari-payment-1");
  assert.equal(
    result.value.providerMetadata?.checkoutUrl,
    "https://checkout.flutterwave.com/v3/hosted/pay/test-link"
  );

  const request = fixture.http.requests[0]!;
  const body = request.body as {
    payment_options?: string;
    subaccounts?: Array<Record<string, unknown>>;
  };

  assert.equal(body.payment_options, "mobilemoneyxaf");
  assert.deepEqual(body.subaccounts, [{
    id: "RS_TEST_CM_001",
    transaction_charge_type: "flat",
    transaction_charge: 1500
  }]);
});

test("transaction verification uses Flutterwave verify-by-reference and normalizes status", async () => {
  const fixture = connector();

  const result = await fixture.connector.verifyPayment({
    externalReference: "zamari-payment-1"
  }, supportedContext);

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.status, "succeeded");
  assert.equal(result.value.providerReference, "FLW-MOCK-98765");
  assert.deepEqual(result.value.amount, {
    amountMinor: 50000,
    currency: "XAF"
  });

  const request = fixture.http.requests[0]!;
  assert.equal(request.method, "GET");
  assert.match(request.url, /verify_by_reference/);
  assert.match(request.url, /tx_ref=zamari-payment-1/);
});
