# Atomic Fapshi sandbox confirmation — #24 / #27 / #29

Update (2026-10-20): `FapshiConfirmation` now runs this same transaction for an
explicit `sandbox` or `live` environment. `FapshiSandboxConfirmation` is a thin
compatibility adapter. Historical sandbox scope below is not a second financial
implementation. See [environment configuration](fapshi-environments.md).

State: **library foundation merged only after real PostgreSQL CI**. No webhook endpoint, REST authorization, delivery worker, consumer credits, secrets, or live Fapshi collections are configured by this feature.

## Single transaction and sequence

`FapshiSandboxConfirmation.confirm(paymentId)` is an internal sandbox-only coordinator with a configured project/merchant and expected Fapshi service name.

1. Read a payment scoped to configured project and merchant; refuse an unbound/non-XAF/non-sandbox operation.
2. Call the Fapshi connector's authenticated `GET /payment-status/:transId` **before opening a PostgreSQL transaction**. No browser redirect, unauthenticated event or webhook field can satisfy this step.
3. Accept only `SUCCESSFUL` Collection with matching PSP reference, application external ID, configured service name, exact XAF gross amount and valid provider revenue/fee arithmetic.
4. Open one SQL `BEGIN`, take the pilot's payment transaction lock, check active project and merchant, reread the payment and its unique Fapshi binding.
5. Apply the existing `PaymentService` succeeded transition and event audit using a client-bound transaction adapter.
6. Append the immutable gross/PSP fee/net journal through `LedgerService` using that **same** `PoolClient`. Conflict fails the entire transaction.
7. Enqueue exactly one `payment.confirmed` outbox record through `enqueueOutboxInTransaction` using the **same** `PoolClient`; the outbox payload contains no page/credit entitlement.
8. `COMMIT` all three effects; otherwise `ROLLBACK` everything. The first persisted successful transition anchors ledger timestamps, so later PSP re-verifications replay the same fingerprint.

## Safety and unfinished workflows

- This is deliberately a **separate internal class** and **sandbox-only**. No public endpoint exists. A future authenticated worker must orchestrate it, verify `x-wh-secret` in constant time at ingress, rate-limit status reads (Fapshi documented max six/minute per transaction), and handle ambiguous/provider-unreachable states.
- A `payment.confirmed` notification is **not** authorization to grant translation credits. Précis must bind the stable purchase/quote, check its own idempotency key, and grant only once after verifying its business rules. Multiple deliveries are expected.
- The status query is done outside the financial lock; inside the transaction the local payment, binding, active merchant, amount and service evidence are checked again.
- Unique constraints, transaction-scoped lock and consistent ledger fingerprinting protect against concurrent calls and process restarts at pilot volume. Not a scale/throughput guarantee.
- No real Fapshi credentials or approval have been verified on the Trigenys account. Do not activate live before the account-specific gates in #23 and end-to-end tests in #30.
- Future operational work: signed worker-to-Précis delivery, consumer inbox, webhook ingress, scheduled reconciliation/429 backoff, restore drill, alerting and environment composition.

## Tests

Real PostgreSQL 17 integration tests cover four concurrent confirmations, process-replacement replay, unexpected `FAILED`, wrong service/reference/amount, preexisting financial batch conflict, outbox effect collision and unauthorized project/merchant. Atomic failure proves no completed payment status or new outbox message escaped a rolled-back transaction.

The HTTP server still exposes only the health route and has no live collection implementation.
