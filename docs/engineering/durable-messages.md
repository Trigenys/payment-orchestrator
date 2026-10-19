# Durable inbox/outbox primitives — #24 / #27

Status: **storage and worker-claim primitives only**. Does not receive Fapshi callbacks or deliver HTTP notifications.

## Added
- `PostgresMessageStore.recordInbox`: receipt deduplicated by provider, environment and stable caller-computed normalized fingerprint. A digest collision with mismatched data raises a conflict. Input is **privacy-reviewed normalized context**, never raw credentials, telephone numbers or full webhook bodies.
- `enqueueOutboxInTransaction(client, input)`: intended for a future single DB transaction that persists verified payment status, ledger and entitlement notification before COMMIT. The standalone `store.enqueue` convenience is NOT an atomic payment+ledger+outbox operation.
- `store.lease(projectId)`: claims due notifications with `FOR UPDATE SKIP LOCKED`, a random *fencing token*, bounded attempt counter and lease expiration; project-scoped only.
- `acknowledge` and `retryOrQuarantine`: success or bounded retry only while holding a non-expired matching lease. Terminal attempts become `dead_letter` for operator inspection.
- Migration 003 and real PostgreSQL tests: two workers, duplicates, lease expiration/fencing, retries, rollback and isolation.

## Mandatory next steps before the webhooks can be considered reliable
- Authenticate incoming Fapshi `x-wh-secret` (configured dashboard secret) in constant time before creating any receipt. This is shared-secret authentication, *not* an HMAC body signature.
- Verify provider status through authenticated API, with max 6 reads/min per transId and authoritative matching of merchant/project/provider account/environment/amount/externalId.
- Implement a single payment+ledger+outbox DB unit of work; outgoing messages must **never** be enqueued based solely on a webhook payload or redirected browser.
- Design authenticated and signed notification delivery, retries, dead-letter inspection/replay, consumer-side deduplication and monitoring. Never infer single delivery from a successful worker ACK.
- Include back-pressure, abort/shutdown, retention and backup/restore rehearsals. Ensure provider status retries and financial reconciliation continue even if provider webhook is lost.
- Prohibit production deployment of this partial implementation and keep real Fapshi payments disabled.

The exposed `PostgresMessageStore` does **not** send payments, process secrets, or grant benefits. In particular, no credits are ever awarded by these storage primitives.