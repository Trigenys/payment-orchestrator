# Signed Précis delivery — durable at-least-once outbox

Scope: reusable outbound notification protocol for #27 / #29. **No runtime
activation, deployment, payment initiation or entitlement grant in this PR.**

## Current delivery contract (v1)

`FapshiConfirmation` already records `payment.confirmed` in
`payment_outbox` as part of the **same** PostgreSQL transaction as the payment
status and financial journal. A separate `PrecisOutboxWorker` now:

1. Leases at most 1–3 due records, fenced by the existing SQL lease token.
2. Checks stored intent status is `succeeded`, PSP Fapshi/environment matches,
   gross journal posting exists, and amount, reference and currency match.
3. Restricts destination to `precis-payment-events`, with a statically configured
   Trigenys HTTPS host and fixed `/api/payments/orchestrator/events` path.
   Redirects, query strings, URL credentials, non-HTTPS and arbitrary
   customer-supplied hosts are rejected.
4. Sends **financial evidence only**. It does NOT carry instructions to grant
   pages, change subscriptions or identify a user.

Wire body, with stable `eventId` across retries:

```json
{
  "version": 1,
  "eventId": "<payment_outbox.id>",
  "effectKey": "confirmed-<paymentId>",
  "environment": "sandbox",
  "type": "payment.confirmed",
  "projectId": "<configured project>",
  "paymentId": "<paymentId>",
  "data": {
    "eventType": "payment.confirmed",
    "projectId": "<projectId>",
    "merchantId": "<merchantId>",
    "paymentId": "<paymentId>",
    "externalReference": "<order id>",
    "provider": "fapshi",
    "providerReference": "<psp transId>",
    "amountMinor": 150,
    "currency": "XAF"
  }
}
```

Headers:

- `x-trigenys-event-id`: stable outbox UUID.
- `x-trigenys-key-id`: allowlisted HMAC key id, supports receiver rotation.
- `x-trigenys-timestamp`: UNIX seconds, regenerated for every attempt.
- `x-trigenys-signature`: `v1=<lowercase hex HMAC-SHA256>`.
- `content-type: application/json; charset=utf-8`.

HMAC input is **the raw UTF-8 bytes** of:

```text
v1\n<timestamp>\n<eventId>\n<exact JSON HTTP body>
```

The receiving Précis Python application must validate the HMAC using constant
time comparison (`hmac.compare_digest`), enforce key id/environment/project,
reject timestamps outside ±300 seconds and conflicting eventId/body digests,
and persist the event and any own purchase/quote association transactionally.
The event's `externalReference` must refer to an existing **server-created**
purchase, with matching payment ID, currency, amount, purchased item and user.
No browser callback can supply financial authority.

**ACK contract:** Précis returns **HTTP 204 No Content** with
`x-trigenys-event-ack: <same eventId>` **only after a durable transaction
commits**. Any other status, missing/wrong ACK or transport error is uncertain:
retry with a fresh HMAC timestamp but the SAME eventId and effectKey.
Delivery marks `delivered` only after a matching ACK and successful
fenced SQL acknowledge. Multiple deliveries must have one business effect;
exactly-once delivery cannot be guaranteed by HTTP.

Retries use bounded exponential delay and a five-attempt dead-letter status.
Operators must inspect and explicitly resolve dead letters and mismatched
receipts; no silent financial correction.

## Explicitly disabled runner

`node dist/src/worker/outbox-run-once.js` runs ONE claim at a time, never
starts a loop or listening port. It refuses to run unless the selected
environment has its own enable flag, database and signing credentials.

Sandbox variables:

```ini
PAYMENT_ENVIRONMENT=sandbox
PAYMENT_SANDBOX_OUTBOX_ENABLED=true
PAYMENT_SANDBOX_PROJECT_ID=<known project>
PAYMENT_SANDBOX_DATABASE_URL=<dedicated Postgres DSN>
PAYMENT_SANDBOX_PRECIS_EVENT_URL=https://<approved-host>.trigenys.com/api/payments/orchestrator/events
PAYMENT_SANDBOX_OUTBOX_KEY_ID=<key identifier>
PAYMENT_SANDBOX_OUTBOX_HMAC_SECRET=<random >=32 char secret>
```

Live uses distinct `PAYMENT_LIVE_*` variables and additionally requires
`PAYMENT_LIVE_OUTBOX_APPROVED=true`. Setting the sandbox enable flag never
implicitly enables live; `DATABASE_URL` is not used as a fallback.

**Do not set these flags yet.** Précis currently does not implement this
deduplicating signed receiver or the frozen-order mapping. This worker must
not be installed as a scheduled service until a real sandbox integration
test proves its ACK is issued after durable commit. The existing AWS
worker install and Précis deployment remain unchanged.

## Tests and future work

- Pure HMAC verification/replay key, payload tampering, URL validation,
  status/ACK gating, disabled live configuration.
- Real PostgreSQL: payment/ledger must both exist, environment and amount
  checks, lease expiry/reclaim and delivered status after matching ACK.
- Future: implement the Précis receiver with unique event-id/digest and
  idempotent credits; test lost-ACK, retry, process crashes and key rotation.
- A separate reconciliation sweep for lost Fapshi webhooks is still needed.

As required by RAIDER, this worker reuses existing `PostgresMessageStore`,
Fapshi confirmation and PostgreSQL financial evidence without introducing
another message broker, cloud bill or PSP secret.
