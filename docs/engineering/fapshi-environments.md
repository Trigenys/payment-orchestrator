# One Fapshi connector, two configured environments

`FapshiHostedClient`, `FapshiHostedConnector`, `FapshiConfirmation` and
`createInboxWorker` implement the same hosted-collection flow for sandbox and
live. `PAYMENT_ENVIRONMENT=sandbox|live` selects the environment at process
startup; an HTTP request cannot override it. Missing environment defaults to
sandbox only for compatibility with existing installations.

The PSP origin is allowlisted: `https://sandbox.fapshi.com` or
`https://live.fapshi.com`. Each connector advertises only its bound environment
and rejects cross-environment creation/verification before resolving credentials
or making an HTTP call. No custom provider base URL is accepted.

## Server configuration

Use separate protected env files and separate databases/roles for sandbox and
live. The same container image runs either environment. With `E=SANDBOX` or
`E=LIVE`, configure these keys (the literal key includes the selected suffix):

```text
PAYMENT_ENVIRONMENT=sandbox|live
PAYMENT_SWEEP_ENABLED=false
PAYMENT_API_ENABLED=false
PAYMENT_INBOX_WORKER_ENABLED=false
PAYMENT_<E>_DATABASE_URL=
PAYMENT_<E>_PROJECT_ID=
PAYMENT_<E>_MERCHANT_ID=
FAPSHI_<E>_SERVICE_NAME=
FAPSHI_<E>_APIUSER=
FAPSHI_<E>_APIKEY=
```

The API additionally requires `FAPSHI_<E>_WEBHOOK_SECRET` and
`PAYMENT_<E>_INTERNAL_TOKEN` (each at least 32 characters). The one-shot worker
needs neither ingress secret. Only enable the component being deployed.
Never copy PSP keys into Précis or put their values in command arguments,
GitHub, workflow parameters or logs.

Live configuration never falls back to `DATABASE_URL`, sandbox identities,
sandbox PSP credentials or sandbox enable flags. In sandbox only, the legacy
`DATABASE_URL`, `PAYMENT_SANDBOX_API_ENABLED`, `PAYMENT_SANDBOX_SWEEP_ENABLED`
and `CLOUD_RUN_INBOX_WORKER_ENABLED` remain supported. A new generic enable
flag, when set, takes precedence over its old sandbox counterpart.

`FapshiSandboxConfirmation`, `createSandboxInboxWorker` and
`createFapshiSandboxRoutes` remain thin compatibility adapters over the common
implementation. Existing sandbox imports, paths, effect keys and outgoing
payloads retain their behavior. No public SDK contract changes.

## Routes and durable effects

The selected API instance exposes only its own paths:

- `POST /v1/webhooks/fapshi/<sandbox|live>` authenticates and persists an
  observation; it does not mark the payment paid.
- `GET /v1/<sandbox|live>/payments/:id` reads persisted state.
- `POST /v1/<sandbox|live>/payments/:id/confirm` reserves a status-read attempt,
  verifies the PSP status and commits payment + journal + outbox atomically.

Apply migrations through `006_fapshi_environments` before either runtime is
ready. Migration 006 widens the original sandbox-only status-budget constraint
without changing existing rows. Inbox claims, lease updates, PSP-reference
bindings, confirmation and status budgets are scoped by environment. Separate
databases remain the deployment boundary; SQL scoping adds another safeguard.

## Deployment status and limits

This change supplies live configuration and shared processing, not live
credentials or a completed Précis checkout integration. No PSP POST, real-money
payment, entitlement grant, outgoing delivery or scheduler is activated by
building, testing or staging the image. Hosted creation still needs the durable
ambiguous-initiation API orchestration tracked separately in #26/#29.

The existing Cloudflare deployment is intentionally a disabled sandbox instance
with its sandbox Hyperdrive binding. It now uses the same environment-aware
composition with `environment: sandbox`; it is not a live binding or an answer
to the measured CPU overrun. The existing AWS host is the deployment target for
the shared financial worker. Do not reuse sandbox Hyperdrive/database credentials
for live.

Contract coverage includes live/sandbox origins and credentials, invalid modes,
missing live values, cross-environment requests, live webhook isolation and a
PostgreSQL financial sweep in both environments with colliding PSP references,
independent quotas and replay-safe ledger/outbox effects. PSP HTTP is simulated
in these tests; no test charges a customer.

Official environment documentation:
https://docs.fapshi.com/en/api-reference/preliminary-knowledge/environment
