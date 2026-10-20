# Opt-in sandbox HTTP API / Fapshi webhook receiver (#26 / #27)

Compatibility note (2026-10-20): these sandbox paths and variables remain valid.
The implementation is now shared with an explicitly selected live environment;
see [environment configuration](fapshi-environments.md). The sandbox adapter
delegates to `createFapshiRoutes` and cannot enable live by itself.

**OFF by default. No Fapshi production checkout or Précis credit allocation is enabled.** The default service still only exposes `GET /health`.

## Routes (when explicitly enabled)

| Method + route | Authentication | Effect |
| --- | --- | --- |
| `GET /health` | None | Process liveness only; **not** database readiness |
| `GET /ready` | None | 200 only if migration versions 001–004 exist in PostgreSQL |
| `POST /v1/webhooks/fapshi/sandbox` | Exactly one `x-wh-secret` (constant-time hash comparison) | Validates JSON size, Collection + service + transaction ID; stores a **redacted normalized** event in the PostgreSQL inbox; ACK 200 only after durable insert; no PSP request and no credit |
| `GET /v1/sandbox/payments/:paymentId` | Internal bearer token | Scoped read-only persisted payment status; never queries Fapshi |
| `POST /v1/sandbox/payments/:paymentId/confirm` | Internal bearer token, empty body | Reserves a shared PostgreSQL verification attempt, then uses the existing Fapshi sandbox coordinator to query authenticated PSP status and commit payment+ledger+outbox atomically |

No anonymous status, credit, checkout creation, payout, refund or settlement endpoints. Unknown routes remain 404. No CORS allowance for browsers.

## Configuration: opt in explicitly

Use an isolated sandbox environment and server-managed secret store; **never commit these values** or share them with Précis clients.

```ini
PAYMENT_SANDBOX_API_ENABLED=true
DATABASE_URL=<sandbox PostgreSQL DSN>
PAYMENT_SANDBOX_PROJECT_ID=<pre-provisioned project>
PAYMENT_SANDBOX_MERCHANT_ID=<pre-provisioned merchant>
PAYMENT_SANDBOX_INTERNAL_TOKEN=<random 32+ character bearer secret>
FAPSHI_SANDBOX_WEBHOOK_SECRET=<random 32+ character secret, configured in dashboard>
FAPSHI_SANDBOX_APIUSER=<Fapshi sandbox apiuser>
FAPSHI_SANDBOX_APIKEY=<Fapshi sandbox apikey>
FAPSHI_SANDBOX_SERVICE_NAME=<exact provider service name>
```

The server **fails at startup** if any required env var is missing; the webhook/internal secrets require at least 32 characters. PostgreSQL schema must be migrated in a separate controlled job before starting. Configure network TLS/firewalls and HTTPS reverse proxy in deployment, with the API behind an internal gateway. The application does not provision or deploy anything here.

### Webhook threat model

Per the official provider docs, Fapshi sends a webhook once per event, and when a service webhook secret is configured its plaintext shared secret arrives in the `x-wh-secret` header. This **is not an HMAC-signature of the request body**. The receiver compares its header using constant-time SHA-256 equality, rejects multiple header values, accepts JSON up to 8 KiB, and checks `transId`, event status, transaction type and service name. It does **not** persist payerName, email, phone, redirectUrl, full provider body or secret. It stores enough to reconcile later.

A valid header is **not payment proof**. Incoming `SUCCESSFUL`, `FAILED` and `EXPIRED` notifications are stored as untrusted messages without changing payment status. The authenticated internal confirmation route queries Fapshi's status endpoint, compares externalReference, amount, service, PSP reference and financials to a previously bound PostgreSQL order and commits financial effects atomically. Inbound failed/expired attempts never auto-mark an irreversible failure.

The documented Fapshi status endpoint allows at most **six reads per transaction per minute**. This service reserves at most **five attempts in any rolling 60 seconds** in a PostgreSQL table with an advisory lock across replicas; **failed requests still consume a slot**. Any additional services using the same Fapshi credentials must share a global budget. There is no automatic polling yet and no webhook-triggered confirmation worker.

### Remaining gates (do not deploy live)

- Finish the inbox worker: claim durable events, process/reconcile after crashes, status read backoff, permanent failures, dead letters and retention. This implementation only **records** webhooks.
- Add signed outbound HTTP dispatch, consumer-side purchase reconciliation/idempotency and a deliberately scoped Précis pilot; grant pages only on the Précis side.
- Test genuine sandbox Fapshi callbacks/credentials and status; then prove one-time entitlement grants, retries, 429 handling and backup/restore under restart.
- Separate live infrastructure, tenant access, operational monitoring, secret rotation and user-facing quotes. No live enablement from this branch.
- No public initiation route is included until a persistent non-retryable **PSP POST initiation state** is implemented, since Fapshi `externalId` is not documented as an idempotency key.

Official reference: https://docs.fapshi.com/en/api-reference/endpoint/webhook
