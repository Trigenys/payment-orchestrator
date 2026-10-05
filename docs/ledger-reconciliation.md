# Ledger and reconciliation

Status: core financial evidence model for issue #10.

## Boundary

The ledger is an **append-only accounting and reconciliation mirror**.

It is not:
- a customer wallet;
- a merchant wallet;
- a redeemable stored-value balance;
- a replacement for provider settlement records.

Payment providers remain authoritative for actual collection and settlement.

## Ledger evidence

The core records immutable entries for:

- payment gross amount;
- provider fee when known;
- merchant share;
- platform/application commission;
- refunds;
- manual/provider adjustments;
- settlement observations;
- payout observations.

Every entry carries:

- project ID;
- merchant ID;
- optional payment/settlement IDs;
- deterministic source key;
- integer minor-unit Money + explicit currency;
- provider/provider reference when applicable;
- occurred/recorded timestamps.

## Idempotency

A ledger batch is unique by:

```text
projectId + sourceKey
```

The batch payload is fingerprinted.

- same source key + same evidence → replay;
- same source key + different evidence → `ledger_conflict`;
- concurrent duplicate writes converge to one batch.

A durable SQL adapter must preserve equivalent semantics using transactions and unique constraints.

## Corrections

Historical entries are never edited.

Corrections use new evidence:

- `refund`
- `adjustment`
- a newer settlement observation

This preserves a complete audit trail.

## Reconciliation

Reconciliation compares internal state against authoritative provider evidence.

### Payment checks

- amount;
- currency;
- normalized payment status;
- external reference;
- provider reference;
- ledger gross;
- provider fee;
- merchant share;
- platform commission.

### Settlement checks

- amount;
- currency;
- settlement status;
- provider reference;
- settlement observation in the ledger.

## Discrepancy model

A reconciliation run is either:

- `matched`
- `discrepancy`

Explicit discrepancy types include:

- `amount_mismatch`
- `currency_mismatch`
- `status_mismatch`
- `external_reference_mismatch`
- `provider_reference_mismatch`
- `ledger_component_missing`
- `ledger_component_duplicate`
- `ledger_component_mismatch`
- `settlement_status_mismatch`

Discrepancies are data, not silent corrections.

## Replay safety

A reconciliation input snapshot is fingerprinted.

Repeating the exact same reconciliation returns the existing run with `replayed: true`.

If internal/provider evidence later changes, a new run is appended.

## Tenant isolation

Ledger reads and reconciliation runs are always scoped by `projectId`, with optional merchant/payment narrowing.

Persistence adapters must never issue unscoped financial queries.

## Production persistence requirements

The current in-memory adapters prove semantics only.

Before production, durable persistence must provide:

- transactions;
- unique ledger batch constraint on `(project_id, source_key)`;
- immutable/append-only ledger records;
- unique reconciliation run key;
- project/merchant query isolation;
- backups and point-in-time recovery appropriate to financial evidence;
- auditable migration history.
