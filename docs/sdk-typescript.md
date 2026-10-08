# TypeScript SDK contract

Issue: #11

The first-party SDK is `@trigenys/payments`.

## Architectural boundary

```text
consumer business logic
        |
        v
@trigenys/payments
        |
        | HTTPS / REST v1
        v
Payment Orchestrator
        |
        v
provider connectors
```

The SDK is intentionally thin. It owns:

- HTTP transport;
- project authentication header;
- typed public requests/responses;
- idempotency header propagation;
- safe transport retries;
- normalized client-side errors.

It does **not** own:

- payment state transitions;
- provider capability decisions;
- provider selection rules;
- split/commission calculations;
- webhook validation;
- ledger/reconciliation logic;
- PSP credentials.

Those remain server-side.

## Public contract source

REST DTOs live in the `@trigenys/payments-contracts` workspace package. Both API transport and SDK should consume those types rather than independently redefining shapes.

## Canonical paths

The SDK contract currently targets:

- `POST /v1/payments`
- `GET /v1/payments/:paymentId`
- `POST /v1/payments/:paymentId/verify`
- `POST /v1/merchants`
- `GET /v1/merchants/:merchantId`
- `POST /v1/merchants/:merchantId/provider-accounts`
- `GET /v1/merchants/:merchantId/provider-accounts/:providerAccountId`

The server implementation must conform to these shared contracts before external publication.

## Retry rule

Mutation calls that can create durable state require an explicit idempotency key.

If the SDK retries after a network error, HTTP 408, 429 or 5xx, the same key and request body are reused.

A mutation without an idempotency key is not automatically retried.

Verification and GET operations are transport-retryable because they are semantically read/reconciliation operations.

## Provider neutrality

Normal payment creation contains no provider name. Provider choice belongs to Payment Orchestrator configuration/routing.

Provider account creation may carry an optional `routing.provider` hint because that operation explicitly provisions provider-bound infrastructure. It is optional rather than part of normal payment business logic.

## Publishing gate

The package remains private until:

- REST API v1 endpoints are implemented against the shared contracts;
- authentication is wired into the HTTP server;
- one local end-to-end integration test covers API + SDK + payment core;
- versioning/backward-compatibility policy is frozen.
