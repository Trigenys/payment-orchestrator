# Fapshi / Précis collection contract — preliminary evidence (2026-10-19)

Status: **documentation reviewed; Trigenys service entitlement NOT verified.** This is groundwork for #23 and #22, not a live-activation authorization.

## Public provider contract (official Fapshi documentation)

| Question | Documented behavior | Pilot decision |
|---|---|---|
| Initiate hosted checkout | `POST /initiate-pay` with `apiuser` and `apikey`; response `link`, `transId`, `dateInitiated` | Use hosted checkout only |
| XAF minimum | Integer `amount >= 100` XAF | Do not attempt single-page 75 XAF checkout; commercial decision in #28 |
| Customer/reference fields | `email` and `redirectUrl` optional; `externalId` and `userId` 1–100 ASCII characters [A–Z,a–z,0–9,_,-] | Persist exact order-to-`transId` binding |
| Hosted-link expiration | 24 hours | Expiration and retries handled by durable order state |
| Payment verification | `GET /payment-status/:transId`; at most 6 calls/min per transaction | Shared orchestrator reconciler; never poll per browser tab |
| Provider states | CREATED, PENDING, SUCCESSFUL, FAILED, EXPIRED | Treat FAILED conservatively as a possibly failed attempt until terminal semantics are confirmed. SUCCESSFUL/EXPIRED are terminal in docs |
| Reconciliation | Status response has `transType`, `amount`, `revenue`, `externalId`, `serviceName`, `transId` | Match all expected fields before financial effects |
| Notifications | Service-level webhook sends events once; `x-wh-secret` header contains configured shared secret | Durable inbox, authenticate, then read authoritative status; never trust callback alone |
| DirectPay | A separate `/direct-pay` endpoint exists in docs | Disabled: specific Trigenys entitlement not verified |
| Payouts/splits/cards/refunds | Not established for the bounded Précis account by current evidence | Do not advertise these capabilities |

Documentation: https://docs.fapshi.com/en/api-reference/endpoint/initiate-pay , https://docs.fapshi.com/en/api-reference/endpoint/payment-status , https://docs.fapshi.com/en/api-reference/endpoint/webhook , https://docs.fapshi.com/en/api-reference/endpoint/direct-pay

## Mandatory account-specific evidence before live

- [ ] Identify the approved **Trigenys collection service** (identifier recorded in a private secret store, never this repository).
- [ ] Verify sandbox and production `apiuser`/`apikey` access by separately configured secrets; do not copy sandbox keys to production.
- [ ] Obtain written or dashboard-backed confirmation for **hosted XAF collection** and available networks (MTN MoMo and Orange Money) on this service.
- [ ] Confirm any service activation, webhook dashboard configuration, egress allowlist, return URL and transaction limits.
- [ ] Verify live fee schedule, dispute/refund rules and settlement destination with Fapshi; `revenue` is net, `amount` is gross.
- [ ] Confirm whether FAILED is an attempt-level state that can later become SUCCESSFUL under the same `transId`; until then no irreversible failed state or automatic fallback.
- [ ] Confirm whether DirectPay is authorized *independently*; it remains disabled by default.
- [ ] Complete #24 durable runtime, #26 authenticated REST API, #27 callback reconciliation and #30 sandbox/live gates before any real payments.

## Integration safety

This connector does **not** directly credit Précis. Précis owns the quote, purchase, pages and entitlements; Payment Orchestrator owns collection and reconciliation. Store a payment intent and stable reference **before** the POST. If the response is missing or ambiguous, do not repeat initiation or switch PSP automatically; require authoritative lookup or operator intervention. Fapshi's `externalId` helps reconciliation but is not a documented idempotent creation key. One `SUCCESSFUL` response is not sufficient without matching the persistent project, merchant, provider account, environment, original quote and amount.

The unverified live service is intentionally not enabled in the initial adapter. No credentials should be committed or included in GitHub issue comments.
