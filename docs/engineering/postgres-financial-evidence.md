# PostgreSQL financial evidence durability — phase 2 of #24

Status: **finance persistence adapters implemented, but orchestration/activation still gated**.

## Included
- `PostgresLedgerPersistence`: immutable gross/fees/merchant-share entries written with their deterministic batch in a single SQL transaction. Unique `(project_id, source_key)` means a replay returns existing evidence and conflicting evidence is rejected.
- `PostgresReconciliationPersistence`: replay-safe, immutable comparison runs retained for incident audit; known discrepancies are saved rather than silently correcting the ledger.
- `migrations/002_financial_persistence.sql`: indexed finance lookup and unique reconciliation keys. Safe repeat application via existing migration runner.
- Services can use asynchronous SQL ports while keeping the existing in-memory test ports.
- CI on PostgreSQL 17 tests concurrent workers on separate pool instances, restart/replay, tenant scoping, original gross immutability and failed writes.

## Important boundary

`PaymentService`, `LedgerService`, and `ReconciliationService` currently each own an *independent* transaction. A correct SQL adapter alone does not guarantee a **single transaction** for provider-verified status + ledger posting + outbox notification. That invariant requires an orchestrated unit-of-work; **no callback handler or payment activation may assume it exists yet**.

The adapter uses the payment persistence's transaction-scoped advisory lock `(54421,24)` to serialize in this small pilot; this is not a scalability claim or a replacement for granular constraints under higher throughput.

## Remaining for #24 and #27

- Durable webhook inbox validation, outbox producer and worker lease/ack/retry, dead-letter recovery, and transactional verification-to-ledger-to-outbox commit.
- Worker recovery/reconciliation upon downtime; processing controls for one Fapshi webhook attempt and throttled status checks.
- Secure provisioning and backup/restore rehearsal, secrets, TLS, readiness and monitoring.
- Approval of account-specific Fapshi service rights and quote pack rule; neither is implied by this merge.

No live collection or changes to Précis production.