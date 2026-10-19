# PostgreSQL PaymentPersistence — foundation for #24

Status: **payment-state adapter implemented; other financial persistence and runtime orchestration remain pending**.

The database is required before a Fapshi initiation POST, but this PR **does not call Fapshi**, configure real credentials, start a worker or replace production's current in-memory runtime. The existing in-memory adapter remains the default. Do not deploy a collection endpoint using it.

## Why this implementation

The existing transaction port contained only synchronous accessors, despite real SQL I/O being asynchronous. This change makes the `PaymentTransaction` methods promise-compatible and converts PaymentService callbacks to asynchronous work. Existing in-memory semantics and provider-neutral interfaces remain intact.

`PostgresPaymentPersistence` serializes payment mutations across processes with a **transaction-scoped advisory lock**. This avoids concurrent creation/binding/event races during the small initial pilot, at the expense of serial throughput; this must be narrowed to per-tenant/intent locking before higher-volume consumers. Schema unique constraints are the final safety barrier.

## First migration

`migrations/001_payment_core.sql` establishes Project/Merchant/ProviderAccount identities, Payment, creation reservations, PSP bindings, provider events and transition history. Inbox/outbox/ledger/reconciliation tables are **schema only** until their adapters/workers are implemented in later parts of #24/#27.

## Local setup (development database only)

1. Provision a fresh PostgreSQL database dedicated to development (do not point to production).
2. Set `DATABASE_URL` (never check this value into git).
3. Run `npm install --ignore-scripts`, `npm run build`, `npm run db:migrate`.
4. Seed project + merchant records for the test environment; foreign keys intentionally reject unknown consumers.
5. Configure `PostgresPaymentPersistence` as the persistence port in a future REST composition layer **only after all payment flow requirements are implemented**.

The `db:migrate` command is additive and uses `schema_migrations` for versioning; rollback is an explicit backup/restore procedure, not automatic data deletion. A repeat migration must be no-op.

## Tests and readiness

CI exercises real PostgreSQL with concurrent PaymentService instances, idempotent replays, PSP-reference uniqueness, rollbacks and restart-survival. Liveness remains `GET /health` and only the separate `checkPostgresReadiness` helper inspects migration state. The HTTP readiness route is not yet wired.

## Outstanding (do not close #24)

- Persist ledger and reconciliation services transactionally alongside payment transitions.
- Implement inbox/outbox workers, task leases, retries and payout/fee reconciliation after restart.
- API/service composition, environment separation, backups, **tested restore**, SQL privilege minimization, connection TLS and observability.
- Confirm hosting spend before provisioning resources and retain explicit live activation gate.
