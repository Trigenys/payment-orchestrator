# Payment state machine and idempotency

Status: foundation contract for issue #5.

## Principle

Every payment is one logical operation. Network retries, duplicate HTTP requests and duplicate PSP callbacks must converge on that same operation instead of producing a second financial effect.

## Consumer idempotency

Payment creation requires an `idempotencyKey` scoped to the Trigenys `Project`.

The service computes a deterministic fingerprint from the payment request. The idempotency key itself is not part of that fingerprint.

Behavior:

- first request → creates one logical Payment;
- same key + same request → returns the existing Payment with `replayed: true`;
- same key + different request → returns `idempotency_conflict`;
- concurrent identical requests → one creation, all others replay the same Payment.

A retry after a transient provider/network error must reuse the **same logical payment and the same idempotency context**. It must not mint another payment ID simply because an HTTP attempt failed.

## Provider reference binding

A PSP payment reference is bound through the tuple:

```text
provider + environment + providerPaymentReference
```

That tuple is unique. Rebinding the same tuple to the same Payment is idempotent. Binding it to a different Payment is a conflict.

## Normalized states

```text
created
  ├─> pending ─> authorized ─> succeeded ─> partially_refunded ─> refunded
  │      │           │             └──────────────────────────────> refunded
  │      │           ├─> failed
  │      │           └─> cancelled
  │      ├─> succeeded
  │      ├─> failed
  │      └─> cancelled
  ├─> authorized
  ├─> succeeded
  ├─> failed
  └─> cancelled
```

`failed`, `cancelled` and `refunded` are terminal for this payment attempt.

`succeeded` is not terminal because refunds may follow.

## Out-of-order provider events

Provider callbacks are normalized by a connector before reaching this state machine.

The core never sees provider-specific status names.

For a normalized provider event:

- same target state → `ignored_duplicate_state`;
- an earlier progress state arriving late → `ignored_stale`;
- a valid forward transition → `applied`;
- a contradictory/impossible transition → `rejected_invalid_transition`.

Ignored or rejected events remain in the audit log. They do not mutate the payment.

Example:

```text
15:10 succeeded received
15:11 pending event arrives late, occurred at 15:00
=> payment remains succeeded
=> pending receipt is stored as ignored_stale
```

## Provider event uniqueness

Provider callback uniqueness is:

```text
provider + environment + eventId
```

The normalized event is fingerprinted.

- same event ID + same normalized content → replay of the original outcome;
- same event ID + different normalized content → `provider_event_conflict`.

This prevents an event identifier from being silently reused for a different financial fact.

## Transaction boundary

Creation reservation, payment mutation, provider-event receipt and transition evidence are executed through `PaymentPersistence.transaction()`.

The in-memory adapter serializes concurrent transactions and commits a cloned draft only after the transaction succeeds.

A durable SQL adapter must preserve equivalent semantics with real database transactions and unique constraints at minimum on:

- `(project_id, idempotency_key)`;
- `(provider, environment, provider_payment_reference)`;
- `(provider, environment, provider_event_id)`;
- transition/event source identifiers where applicable.

## Immutable audit evidence

Applied state changes append a `PaymentTransitionEvidence` record. Creation itself is represented as `null -> created`.

Every normalized provider callback receives a `ProviderEventReceipt`, including ignored, rejected and unmatched callbacks.

Historical transition evidence is append-only. A later correction adds evidence; it does not rewrite prior transitions.

## Retry semantics

Provider adapter errors already carry `retryable: boolean`.

The core translates that into:

- `retry_same_operation` — transient failure; retry using the same logical payment/idempotency context;
- `do_not_retry` — terminal or caller-actionable failure.

A retryable transport error by itself must **not** mark a payment `failed`. A Payment becomes `failed` only through an explicit normalized financial state transition.

## Unmatched events

A verified normalized event whose provider payment reference is not known is retained with outcome `unmatched`.

It is not allowed to create or mutate a Payment implicitly. A later reconciliation workflow may inspect and resolve unmatched events.
