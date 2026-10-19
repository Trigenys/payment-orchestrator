# ADR — Durable runtime for Précis / Fapshi pilot (proposal)

Status: **proposed, not implemented** (#24). Related: #22, #5, #6, #10.

## Recommendation and trade-offs

- Use a **transactional PostgreSQL** database for payment records, idempotency reservations, provider-reference bindings, inbox/outbox, append-only ledger and reconciliation. PostgreSQL's unique indexes, row-level locking and transactional outbox align with the existing synchronous `PaymentTransaction` contract; do not silently wrap synchronous in-memory operations around asynchronous SQL.
- Run the API and worker in the current AWS footprint with **separate process roles**. Containerized Node 24 is suitable; do not deploy an additional always-on environment until costs/operations are confirmed.
- Prefer an AWS-managed PostgreSQL service if affordable for automatic backups, upgrade/restore operations and isolation. A dedicated, encrypted PostgreSQL instance on EC2 reduces monthly spend but places backup, patching, point-in-time recovery, availability and on-call duties on Trigenys. **Infrastructure choice and cost ceiling remain to be approved**.
- Use database-backed outbox/inbox and claimed jobs for the first pilot, instead of bringing a new queue dependency into a small service prematurely.
- Credentials come from server-side secret management per environment, never checkout clients. Sandbox and live have separate DB credentials, service identities, PSP keys and network rules.

## Required schema invariants

- `Project`, `Merchant`, `ProviderAccount` are separate identifiers; explicit FKs and tenant scoping.
- Unique payment creation: `(project_id, idempotency_key)`; store fingerprint and stable `payment_id`.
- Unique PSP identity: `(provider, environment, provider_transaction_id)`; never bind a `transId` to a different payment.
- Provider events: unique stable inbox fingerprint scoped to provider + environment (Fapshi does not document a webhook event ID); persist before ACK.
- Immutable transition/ledger entries with unique business-effect keys; unique delivery IDs and consumer inbox for one entitlement grant.
- Outbox claims have leases, attempts, backoff, dead-letter handling and diagnostics; database transaction atomically records verified status, accounting and notifications.
- Ambiguous provider initiation is its own non-retryable state, recovered by operator/reconciler; no replacement POST.
- Project, merchant, provider account, environment and XAF amount must be checked before settlement/credit effects.

## Readiness and operations

`GET /health` can remain liveness; add a separate readiness endpoint backed by database access and worker configuration. Before live: reproducible migrations, daily backups with a **tested restore**, TLS, least-privilege DB user, exit procedure preserving reconciliation, and measured webhook/outbox lag. No provider POST until an intent is durably committed.

## Implementation sequencing

1. Design SQL transaction port or use a split async domain API; keep current in-memory adapter and compatibility tests intact.
2. Implement SQL storage and concurrency tests against real PostgreSQL, including process restart and two workers.
3. Add schema and migration CI, restore rehearsal, and database readiness.
4. Add durable inbox/outbox and reconciliation coordination; only then connect Fapshi callbacks/notifications.
5. Enable API and worker in staging behind a feature flag; leave live collection off pending provider entitlement.

This ADR does not claim that production storage is ready.
