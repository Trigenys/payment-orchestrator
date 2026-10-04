# CinetPay — Cameroon / Marque Blanche feasibility

Date checked: 2026-10-04  
Decision: **CONDITIONAL GO for public collection; marketplace remains unqualified**

This record deliberately separates CinetPay's public Checkout API from the Marque Blanche partner product.

## Publicly verified — Cameroon collection

CinetPay's public Checkout v2 documentation exposes:

```text
POST https://api-checkout.cinetpay.com/v2/payment
POST https://api-checkout.cinetpay.com/v2/payment/check
```

For a Cameroon account, the documented local currency is XAF. CinetPay's payment-method table lists Cameroon Orange Money and MTN Mobile Money in XAF.

References:

- https://docs.cinetpay.com/api/1.0-fr/checkout/initialisation
- https://docs.cinetpay.com/api/1.0-fr/checkout/tableau
- https://docs.cinetpay.com/api/1.0-fr/checkout/verification

The public initialization contract also documents:

- amount must be an integer;
- non-USD amount must be a multiple of 5;
- Cameroon range: 100 to 1,500,000 XAF;
- `MOBILE_MONEY` is a supported Checkout universe;
- transaction IDs must be unique;
- `notify_url` and `return_url` are required.

The Trigenys connector foundation implements only the public behavior we can prove.

## Sandbox limitation

The current CinetPay Checkout documentation explicitly states that sandboxes are temporarily unavailable.

Reference:

- https://docs.cinetpay.com/api/1.0-fr/checkout/initialisation

The same documentation states that API key and site ID can be used for test and production stages, and that a separate account/service can be created for production.

For Payment Orchestrator this means:

- the public capability profile advertises Cameroon/XAF collection for `live`, not `sandbox`;
- automated tests use an injected HTTP transport, never CinetPay production credentials;
- a real-provider smoke test must wait for an account/service that CinetPay confirms is appropriate for testing.

## Webhook security and authoritative state

CinetPay sends an `x-token` HMAC-SHA256 header. The signature is generated from a documented ordered concatenation of notification fields and the merchant Secret Key.

Reference:

- https://docs.cinetpay.com/api/1.0-fr/checkout/hmac

CinetPay explicitly warns that notification payloads are **not** the authoritative source for transaction status. The receiver must call the transaction verification API, and notifications may be delivered multiple times.

Reference:

- https://docs.cinetpay.com/api/1.0-fr/checkout/notification

The connector therefore:

1. verifies `x-token`;
2. extracts the transaction ID;
3. calls `POST /v2/payment/check`;
4. normalizes only the verified status;
5. generates a deterministic event ID from the authoritative state.

A notification value such as `cpm_error_message` is never used as the final payment status.

## Marque Blanche — what the legal terms prove

CinetPay's public service terms describe **CinetPay Marque Blanche** as a product that allows a Partner to:

- aggregate merchants;
- collect payments using the Partner's unique identifiers;
- use APIs to collect and make reversals on behalf of its merchants;
- access activity reports for commission invoicing;
- reconcile transaction data with payment-method providers.

Reference:

- https://cinetpay.com/legal/cgu-services

This is strong evidence that CinetPay has a marketplace/aggregator operating model.

The same terms describe general merchant funds as becoming available on a CinetPay balance within a maximum of eight days after collection, with withdrawal/reversal mechanisms including bank transfer and, under described conditions, Mobile Money/wallet.

That public text is useful for understanding the broad money flow, but it is **not** a substitute for the private Marque Blanche API and commercial contract.

## What public documentation does NOT prove

No current public documentation located for this spike proves:

- a public downstream-merchant creation endpoint;
- the exact downstream merchant identifier/model;
- fully API-driven merchant KYB onboarding;
- separate merchant balances in the White Label API;
- automatic per-payment platform commission/split semantics;
- whether CinetPay or the Partner legally holds/controls collected funds at each stage of the White Label flow;
- Cameroon-specific merchant settlement destinations for White Label;
- private webhook/event contracts for merchant lifecycle;
- partner pricing, reserves, minimum volume or settlement schedule;
- current White Label sandbox access.

Therefore Payment Orchestrator does **not** advertise:

- `marketplace_accounts`;
- `split_payments`;
- `payouts`;
- `settlement_status`

for CinetPay yet.

The standard Checkout API must never be presented as if it were Marque Blanche marketplace support.

## Implemented public connector

The current `cinetpay-v2` foundation implements:

- Cameroon/XAF `collect`;
- Cameroon/XAF `mobile_money`;
- Checkout v2 initialization;
- amount/range/multiple-of-five validation;
- authoritative transaction verification;
- `x-token` HMAC-SHA256 verification;
- duplicate-safe normalized webhook events;
- explicit fail-closed marketplace capability behavior.

It does not generate fake checkout URLs or fake provider transaction identifiers.

## Partner questions required before marketplace implementation

CinetPay must provide/confirm:

1. private Marque Blanche API documentation;
2. how a downstream merchant is created and identified;
3. exact KYB/KYC responsibility: CinetPay, Partner, or both;
4. whether each merchant gets a legally/accountingly separate balance;
5. how platform commission is represented;
6. whether collection is directly attributed to a downstream merchant;
7. how and when merchant settlement/reversal occurs;
8. Cameroon bank and Mobile Money settlement options;
9. webhook contracts for merchant/payment/reversal lifecycle;
10. test/sandbox access for Marque Blanche;
11. partner pricing, reserves and minimum volume.

## Current verdict

### Public CinetPay Checkout

**GO as a technically documented direct-collection connector**, subject to obtaining appropriate account credentials before any real-provider smoke test.

### CinetPay Marque Blanche

**CONDITIONAL GO / NOT YET IMPLEMENTABLE.**

The product is real and the legal terms describe the right marketplace shape, but the public surface is insufficient to implement merchant onboarding, split/commission and settlement semantics safely.

Issue #8 remains open until private partner documentation or direct CinetPay confirmation answers those questions.
