import assert from "node:assert/strict";
import test from "node:test";
import { createMoney } from "../src/domain/money.js";
import {
  FapshiHostedClient,
  FapshiHostedConnector,
  fapshiHostedCapabilityProfile,
  mapFapshiStatus
} from "../src/providers/fapshi/index.js";
import { evaluateCapability } from "../src/providers/capabilities.js";
import type {
  ProviderHttpClient,
  ProviderHttpRequest,
  ProviderHttpResponse
} from "../src/providers/http.js";
import { runProviderContractSuite } from "./support/provider-contract.js";

class StubHttpClient implements ProviderHttpClient {
  readonly requests: ProviderHttpRequest[] = [];
  createStatus = 200;
  verifyStatus = 200;
  providerStatus = "SUCCESSFUL";
  invalidLink = false;
  invalidService = false;
  wrongAmount = false;
  throwOnCreate = false;
  statusType = "Collection";

  async request<T = unknown>(
    request: ProviderHttpRequest
  ): Promise<ProviderHttpResponse<T>> {
    this.requests.push(request);
    if (request.method === "POST" && request.url.endsWith("/initiate-pay")) {
      if (this.throwOnCreate) throw new Error("Simulated lost POST response");
      return {
        status: this.createStatus,
        body: {
          link: this.invalidLink
            ? "http://other.example/checkout"
            : "https://sandbox.fapshi.com/pay/txn-123",
          transId: "txn-123",
          dateInitiated: "2026-10-19",
          message: "created"
        } as T
      };
    }
    if (request.method === "GET" && request.url.includes("/payment-status/")) {
      return {
        status: this.verifyStatus,
        body: {
          transId: decodeURIComponent(request.url.split("/").at(-1) ?? ""),
          status: this.providerStatus,
          transType: this.statusType,
          externalId: "payment-1",
          serviceName: this.invalidService ? "different-service" : "trigenys-sandbox",
          amount: this.wrongAmount ? 50 : 10_000,
          revenue: 9_800,
          medium: "orange money"
        } as T
      };
    }
    return { status: 404, body: { message: "unexpected" } as T };
  }
}

const sandboxContext = {
  projectId: "project-precis",
  environment: "sandbox" as const,
  country: "CM",
  currency: "XAF"
};
const liveContext = {
  ...sandboxContext,
  environment: "live" as const
};

function fixture() {
  const http = new StubHttpClient();
  const client = new FapshiHostedClient({
    httpClient: http,
    getCredentials: async () => ({
      apiuser: "dummy-sandbox-user",
      apikey: "dummy-sandbox-key"
    })
  });
  let id = 0;
  const connector = new FapshiHostedConnector({
    client,
    projectId: "project-precis",
    merchantId: "merchant-1",
    expectedServiceName: "trigenys-sandbox",
    now: () => "2026-10-19T09:00:00.000Z",
    newId: () => `test-payment-${++id}`
  });
  return { http, client, connector };
}

function paymentInput(amountMinor = 150, externalReference = "payment-1") {
  return {
    projectId: "project-precis",
    merchantId: "merchant-1",
    externalReference,
    amount: createMoney(amountMinor, "XAF"),
    channel: "mobile_money" as const,
    customer: { email: "buyer@example.com" },
    redirectUrl: "https://precis.example/payments/return"
  };
}

runProviderContractSuite("FapshiHostedConnector", {
  createConnector: () => fixture().connector,
  supportedContext: sandboxContext,
  unsupportedContext: liveContext,
  collectionChannel: "mobile_money",
  marketplaceAccountsExpected: "unsupported"
});

test("only XAF/Cameroon sandbox hosted collection is advertised", () => {
  for (const cap of ["collect", "mobile_money"] as const) {
    assert.equal(evaluateCapability(fapshiHostedCapabilityProfile, cap, sandboxContext).supported, true);
    assert.equal(evaluateCapability(fapshiHostedCapabilityProfile, cap, liveContext).supported, false);
  }
  for (const cap of ["refunds", "payouts", "marketplace_accounts", "split_payments", "settlement_status"] as const) {
    assert.equal(evaluateCapability(fapshiHostedCapabilityProfile, cap, sandboxContext).supported, false);
  }
});

test("initiate-pay creates hosted link, binds transId, retains XAF and uses bounded timeout", async () => {
  const { connector, http } = fixture();
  const result = await connector.createPayment(paymentInput(), sandboxContext);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.status, "pending");
  assert.equal(result.value.externalReference, "payment-1");
  assert.equal(result.value.providerReference, "txn-123");
  assert.equal(result.value.providerMetadata?.checkoutUrl, "https://sandbox.fapshi.com/pay/txn-123");
  assert.equal(result.value.providerMetadata?.linkExpiresAfterHours, 24);

  const req = http.requests[0]!;
  assert.equal(req.url, "https://sandbox.fapshi.com/initiate-pay");
  assert.equal(req.method, "POST");
  assert.equal(req.timeoutMs, 10_000);
  assert.equal(req.headers?.apiuser, "dummy-sandbox-user");
  assert.equal(req.headers?.apikey, "dummy-sandbox-key");
  assert.deepEqual(req.body, {
    amount: 150,
    externalId: "payment-1",
    redirectUrl: "https://precis.example/payments/return",
    email: "buyer@example.com"
  });
});

test("rejects 75 XAF, unsupported accounts, splits and invalid externalId before HTTP", async () => {
  const { connector, http } = fixture();
  const low = await connector.createPayment(paymentInput(75), sandboxContext);
  assert.equal(low.ok, false);
  const invalid = await connector.createPayment(paymentInput(150, "order#1"), sandboxContext);
  assert.equal(invalid.ok, false);
  const account = await connector.createPayment({
    ...paymentInput(),
    merchantId: "merchant-other"
  }, sandboxContext);
  assert.equal(account.ok, false);
  const split = await connector.createPayment({
    ...paymentInput(),
    allocations: [{ providerAccountId: "other", amount: createMoney(140, "XAF") }]
  }, sandboxContext);
  assert.equal(split.ok, false);
  if (!split.ok) assert.equal(split.error.code, "capability_unsupported");
  assert.equal(http.requests.length, 0);
});

test("a failed or uncertain initiation is never marked retryable", async () => {
  const { connector, http } = fixture();
  http.throwOnCreate = true;
  const timeout = await connector.createPayment(paymentInput(), sandboxContext);
  assert.equal(timeout.ok, false);
  if (!timeout.ok) {
    assert.equal(timeout.error.code, "unknown");
    assert.equal(timeout.error.retryable, false);
  }
  assert.equal(http.requests.length, 1);

  http.throwOnCreate = false;
  http.createStatus = 500;
  const serverError = await connector.createPayment(paymentInput(), sandboxContext);
  assert.equal(serverError.ok, false);
  if (!serverError.ok) assert.equal(serverError.error.retryable, false);

  http.createStatus = 200;
  http.invalidLink = true;
  const untrustedLink = await connector.createPayment(paymentInput(), sandboxContext);
  assert.equal(untrustedLink.ok, false);
  if (!untrustedLink.ok) assert.equal(untrustedLink.error.retryable, false);
});

test("verification reads transId, checks collection/service and separates gross from net", async () => {
  const { connector, http } = fixture();
  const verified = await connector.verifyPayment({ externalReference: "txn-123" }, sandboxContext);
  assert.equal(verified.ok, true);
  if (!verified.ok) return;
  assert.equal(verified.value.status, "succeeded");
  assert.equal(verified.value.externalReference, "payment-1");
  assert.equal(verified.value.providerReference, "txn-123");
  assert.deepEqual(verified.value.amount, { amountMinor: 10_000, currency: "XAF" });
  assert.equal(verified.value.providerMetadata?.revenueMinor, 9_800);
  assert.equal(verified.value.providerMetadata?.feeMinor, 200);
  assert.equal(http.requests[0]!.url, "https://sandbox.fapshi.com/payment-status/txn-123");
  assert.equal(http.requests[0]!.timeoutMs, 10_000);
});

test("failed attempt stays pending; expired checkout is cancelled, unknown status fails closed", async () => {
  const { connector, http } = fixture();
  assert.equal(mapFapshiStatus("FAILED"), "pending");
  assert.equal(mapFapshiStatus("EXPIRED"), "cancelled");
  http.providerStatus = "FAILED";
  const failedAttempt = await connector.verifyPayment({ externalReference: "txn-123" }, sandboxContext);
  assert.equal(failedAttempt.ok, true);
  if (failedAttempt.ok) assert.equal(failedAttempt.value.status, "pending");
  http.providerStatus = "STRANGE";
  const strange = await connector.verifyPayment({ externalReference: "txn-123" }, sandboxContext);
  assert.equal(strange.ok, false);
});

test("status mismatches fail closed and status reads can retry after rate limit", async () => {
  const { connector, http } = fixture();
  http.invalidService = true;
  const accountMismatch = await connector.verifyPayment({ externalReference: "txn-123" }, sandboxContext);
  assert.equal(accountMismatch.ok, false);
  http.invalidService = false;
  http.statusType = "Payout";
  const wrongType = await connector.verifyPayment({ externalReference: "txn-123" }, sandboxContext);
  assert.equal(wrongType.ok, false);
  http.statusType = "Collection";
  http.wrongAmount = true;
  const wrongAmount = await connector.verifyPayment({ externalReference: "txn-123" }, sandboxContext);
  assert.equal(wrongAmount.ok, false);
  http.wrongAmount = false;
  http.verifyStatus = 429;
  const throttled = await connector.verifyPayment({ externalReference: "txn-123" }, sandboxContext);
  assert.equal(throttled.ok, false);
  if (!throttled.ok) {
    assert.equal(throttled.error.code, "rate_limited");
    assert.equal(throttled.error.retryable, true);
  }
});

test("live environment cannot initiate even with dummy sandbox credentials", async () => {
  const { connector, http } = fixture();
  const result = await connector.createPayment(paymentInput(), liveContext);
  assert.equal(result.ok, false);
  assert.equal(http.requests.length, 0);
  if (!result.ok) assert.equal(result.error.code, "capability_unsupported");
});
