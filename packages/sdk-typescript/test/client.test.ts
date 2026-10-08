import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import test from "node:test";
import type {
  ApiErrorResponse,
  ApiSuccess,
  CreatePaymentResponse,
  MerchantView,
  PaymentView,
  ProviderAccountView,
  VerifyPaymentResponse
} from "@trigenys/payments-contracts";
import {
  TrigenysPaymentsClient,
  TrigenysPaymentsError,
  createIdempotencyKey
} from "../src/index.js";

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

function json(
  response: ServerResponse,
  status: number,
  payload: unknown
): void {
  response.writeHead(status, {
    "content-type": "application/json"
  });
  response.end(JSON.stringify(payload));
}

async function withServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>
): Promise<{
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch((error) => {
      json(response, 500, {
        error: {
          code: "test_server_error",
          message: error instanceof Error ? error.message : "unknown"
        }
      });
    });
  });

  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  assert.ok(address && typeof address === "object");

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.close();
      await once(server, "close");
    }
  };
}

const payment: PaymentView = {
  id: "payment-1",
  merchantId: "merchant-1",
  amount: {
    amountMinor: 50_000,
    currency: "XAF"
  },
  status: "pending",
  externalReference: "pay_ext_1",
  createdAt: "2026-10-08T09:00:00.000Z",
  updatedAt: "2026-10-08T09:00:00.000Z"
};

test("create payment retries safely and preserves the same idempotency key", async (t) => {
  const attempts: Array<{
    readonly idempotencyKey?: string;
    readonly authorization?: string;
    readonly body: unknown;
  }> = [];

  const server = await withServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/payments") {
      json(response, 404, {
        error: {
          code: "not_found",
          message: "not found"
        }
      });
      return;
    }

    attempts.push({
      idempotencyKey:
        typeof request.headers["idempotency-key"] === "string"
          ? request.headers["idempotency-key"]
          : undefined,
      authorization: request.headers.authorization,
      body: await readBody(request)
    });

    if (attempts.length === 1) {
      const unavailable: ApiErrorResponse = {
        error: {
          code: "temporarily_unavailable",
          message: "try again"
        }
      };
      json(response, 503, unavailable);
      return;
    }

    const success: ApiSuccess<CreatePaymentResponse> = {
      data: {
        payment,
        checkoutUrl: "https://checkout.example/pay/1"
      },
      requestId: "req-2"
    };
    json(response, 201, success);
  });
  t.after(server.close);

  const client = new TrigenysPaymentsClient({
    baseUrl: server.baseUrl,
    apiKey: "po_test_cred-1.0123456789abcdef0123456789",
    maxRetries: 2,
    retryDelayMs: 0
  });

  const idempotencyKey = "idem_zamari_enrollment_123";

  const result = await client.payments.create({
    merchantId: "merchant-1",
    amount: {
      amountMinor: 50_000,
      currency: "XAF"
    },
    channel: "mobile_money",
    customer: {
      email: "learner@example.com",
      name: "Learner"
    },
    redirectUrl: "https://zamari.example/payments/return"
  }, {
    idempotencyKey
  });

  assert.equal(result.payment.id, "payment-1");
  assert.equal(result.checkoutUrl, "https://checkout.example/pay/1");
  assert.equal(attempts.length, 2);
  assert.deepEqual(
    attempts.map((attempt) => attempt.idempotencyKey),
    [idempotencyKey, idempotencyKey]
  );
  assert.ok(attempts.every(
    (attempt) =>
      attempt.authorization ===
      "Bearer po_test_cred-1.0123456789abcdef0123456789"
  ));
  assert.deepEqual(attempts[0]?.body, attempts[1]?.body);
});

test("retrieve and verify payment use the canonical REST paths", async (t) => {
  const paths: string[] = [];

  const server = await withServer((request, response) => {
    paths.push(`${request.method} ${request.url}`);

    if (request.method === "GET" && request.url === "/v1/payments/payment-1") {
      const success: ApiSuccess<PaymentView> = {
        data: payment
      };
      json(response, 200, success);
      return;
    }

    if (
      request.method === "POST" &&
      request.url === "/v1/payments/payment-1/verify"
    ) {
      const success: ApiSuccess<VerifyPaymentResponse> = {
        data: {
          payment: {
            ...payment,
            status: "succeeded",
            updatedAt: "2026-10-08T09:02:00.000Z"
          },
          verifiedAt: "2026-10-08T09:02:00.000Z"
        }
      };
      json(response, 200, success);
      return;
    }

    json(response, 404, {
      error: {
        code: "not_found",
        message: "not found"
      }
    });
  });
  t.after(server.close);

  const client = new TrigenysPaymentsClient({
    baseUrl: server.baseUrl,
    apiKey: "po_test_cred-1.0123456789abcdef0123456789",
    retryDelayMs: 0
  });

  const retrieved = await client.payments.retrieve("payment-1");
  const verified = await client.payments.verify("payment-1");

  assert.equal(retrieved.id, "payment-1");
  assert.equal(verified.payment.status, "succeeded");
  assert.deepEqual(paths, [
    "GET /v1/payments/payment-1",
    "POST /v1/payments/payment-1/verify"
  ]);
});

test("merchant and provider-account operations remain provider-neutral by default", async (t) => {
  const receivedBodies: unknown[] = [];

  const merchant: MerchantView = {
    id: "merchant-1",
    displayName: "Centre Alpha",
    country: "CM",
    status: "active",
    createdAt: "2026-10-08T09:00:00.000Z"
  };

  const providerAccount: ProviderAccountView = {
    id: "provider-account-1",
    merchantId: merchant.id,
    provider: "configured-provider",
    environment: "sandbox",
    status: "active",
    createdAt: "2026-10-08T09:01:00.000Z"
  };

  const server = await withServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/v1/merchants") {
      receivedBodies.push(await readBody(request));
      const success: ApiSuccess<MerchantView> = {
        data: merchant
      };
      json(response, 201, success);
      return;
    }

    if (
      request.method === "POST" &&
      request.url === "/v1/merchants/merchant-1/provider-accounts"
    ) {
      receivedBodies.push(await readBody(request));
      const success: ApiSuccess<ProviderAccountView> = {
        data: providerAccount
      };
      json(response, 201, success);
      return;
    }

    json(response, 404, {
      error: {
        code: "not_found",
        message: "not found"
      }
    });
  });
  t.after(server.close);

  const client = new TrigenysPaymentsClient({
    baseUrl: server.baseUrl,
    apiKey: "po_test_cred-1.0123456789abcdef0123456789",
    retryDelayMs: 0
  });

  const createdMerchant = await client.merchants.create({
    displayName: "Centre Alpha",
    country: "CM"
  }, {
    idempotencyKey: "idem_merchant_1"
  });

  const createdAccount = await client.providerAccounts.create(
    createdMerchant.id,
    {
      settlementDestination: {
        type: "bank_account",
        country: "CM",
        currency: "XAF",
        bankCode: "CM0001",
        accountNumber: "0000000001"
      },
      contact: {
        email: "centre@example.com"
      }
    },
    {
      idempotencyKey: "idem_provider_account_1"
    }
  );

  assert.equal(createdAccount.merchantId, "merchant-1");

  const accountRequest = receivedBodies[1] as Record<string, unknown>;
  assert.equal("apiKey" in accountRequest, false);
  assert.equal("secretKey" in accountRequest, false);
  assert.equal("provider" in accountRequest, false);
});

test("API errors are normalized into TrigenysPaymentsError and are not retried on 4xx", async (t) => {
  let attempts = 0;

  const server = await withServer((_request, response) => {
    attempts += 1;
    const error: ApiErrorResponse = {
      error: {
        code: "merchant_not_found",
        message: "Merchant does not exist.",
        requestId: "req-bad"
      }
    };
    json(response, 404, error);
  });
  t.after(server.close);

  const client = new TrigenysPaymentsClient({
    baseUrl: server.baseUrl,
    apiKey: "po_test_cred-1.0123456789abcdef0123456789",
    maxRetries: 3,
    retryDelayMs: 0
  });

  await assert.rejects(
    () => client.merchants.retrieve("missing"),
    (error: unknown) => {
      assert.ok(error instanceof TrigenysPaymentsError);
      assert.equal(error.status, 404);
      assert.equal(error.code, "merchant_not_found");
      assert.equal(error.requestId, "req-bad");
      return true;
    }
  );

  assert.equal(attempts, 1);
});

test("idempotency helper creates reusable opaque keys", () => {
  const key = createIdempotencyKey("zamari-payment");
  assert.match(key, /^zamari-payment_[0-9a-f-]{36}$/);
});
