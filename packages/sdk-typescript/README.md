# @trigenys/payments

First-party TypeScript client for Trigenys Payment Orchestrator.

Status: **pre-release / internal integration contract**. The package remains private until REST API v1 is frozen.

## Install

The package is currently consumed from this monorepo workspace.

## Client

```ts
import {
  TrigenysPaymentsClient,
  createIdempotencyKey
} from "@trigenys/payments";

const payments = new TrigenysPaymentsClient({
  baseUrl: process.env.TRIGENYS_PAYMENTS_URL!,
  apiKey: process.env.TRIGENYS_PAYMENTS_API_KEY!
});

const result = await payments.payments.create({
  merchantId: "merchant_centre_alpha",
  amount: {
    amountMinor: 50_000,
    currency: "XAF"
  },
  channel: "mobile_money",
  customer: {
    email: "learner@example.com"
  },
  redirectUrl: "https://example.com/payments/return"
}, {
  idempotencyKey: createIdempotencyKey("enrollment")
});

console.log(result.payment.id, result.checkoutUrl);
```

## Rules

- the SDK calls Payment Orchestrator only; it never calls PSPs directly;
- PSP secret keys are never SDK configuration;
- REST remains the canonical contract;
- write retries require an idempotency key;
- the exact same idempotency key is preserved across transport retries;
- provider selection is server-side by default;
- provider selection may only appear as optional routing policy where the public contract explicitly allows it.

## Errors

HTTP/API failures are exposed as `TrigenysPaymentsError` with:

- `code`;
- `status`;
- `message`;
- optional `details`;
- optional `requestId`.

The SDK retries network errors, HTTP 408, 429 and 5xx only when the operation is retry-safe.

## Runtime

- Node.js 24
- Next.js server runtime
- NestJS / Node backends

Do not put the project API key in browser/client-side code.
