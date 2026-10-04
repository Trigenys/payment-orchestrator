# Flutterwave v3 — Cameroon marketplace feasibility

Date checked: 2026-10-04  
Decision: **CONDITIONAL GO**

This document records what is publicly proven, what is implemented in the connector foundation, and what must still be confirmed with Flutterwave before a live Zamari marketplace flow is enabled.

## Publicly verified

### Cameroon account and XAF rails

Flutterwave publishes Cameroon-specific onboarding requirements and states that Cameroon accounts can accept Card and Mobile Money payments. Its Cameroon support material also states that payouts can be made to bank accounts or mobile-money wallets.

References:

- https://www.flutterwave.com/us/support/general/heres-all-you-need-to-know-about-operating-a-flutterwave-account-in-cameroon
- https://www.flutterwave.com/rw/support/onboarding/onboarding-requirements-for-using-flutterwave-in-cameroon
- https://flutterwave.com/cm/pricing

The current Cameroon pricing page lists:

- local Mobile Money collection: 2%;
- Mobile Money transfer: 1%;
- bank transfer: XAF 1,500.

Pricing is not a guarantee that every marketplace feature is enabled on a specific account.

### Cameroon Mobile Money collection

Flutterwave v3 documents Francophone Mobile Money collection in Cameroon with:

- currency: XAF;
- country: CM;
- networks: MTN and ORANGEMONEY.

References:

- https://developer.flutterwave.com/docs/francophone
- https://developer.flutterwave.com/reference/charge-via-francophone-mobile-money

### Split payments and collection subaccounts

Flutterwave documents split payments specifically for aggregators and marketplaces. The flow uses collection subaccounts and allows the platform to retain a flat or percentage commission.

References:

- https://developer.flutterwave.com/docs/split-payments
- https://developer.flutterwave.com/reference/create-a-sub-account
- https://developer.flutterwave.com/reference/checkout

The v3 Standard endpoint is:

```text
POST https://api.flutterwave.com/v3/payments
```

and accepts a `subaccounts` array.

The collection-subaccount endpoint is:

```text
POST https://api.flutterwave.com/v3/subaccounts
```

The public collection-subaccount contract uses a **bank account** (`account_bank` + `account_number`) as the settlement destination. The current Trigenys connector therefore does **not** advertise Mobile Money as a split-payment settlement destination.

Flutterwave supports generic Cameroon Mobile Money transfers, but that is a different transfer flow and does not by itself prove that marketplace split settlement can settle a collection subaccount directly to Mobile Money.

Reference:

- https://developer.flutterwave.com/docs/mobile-money

### Transaction verification

Flutterwave recommends verifying the authoritative transaction state server-side before giving value.

The v3 verify-by-reference endpoint is:

```text
GET https://api.flutterwave.com/v3/transactions/verify_by_reference?tx_ref=...
```

References:

- https://developer.flutterwave.com/docs/transaction-verification
- https://developer.flutterwave.com/reference/verify-transaction-with-tx_ref

The connector foundation implements this verification call and normalizes Flutterwave status values into the Trigenys payment state model.

### Webhook security

The current Flutterwave v3 webhook documentation uses the configured secret hash in the `verif-hash` request header.

Reference:

- https://developer.flutterwave.com/docs/webhooks

Flutterwave v4 documents a different HMAC-SHA256 scheme using `flutterwave-signature`.

Reference:

- https://developer.flutterwave.com/v4.0.0/docs/webhooks

The connector in this repository targets **Flutterwave v3**, so it implements the v3 `verif-hash` contract. A future v4 connector must be a separate versioned adapter and must not silently change signature semantics.

## Commercial and compliance blocker

Public API availability is **not enough** to declare marketplace support live in Cameroon.

Flutterwave's current Merchant Service Agreement/help material makes two important points:

1. marketplaces require pre-approval;
2. payment facilitators are restricted unless registered/licensed.

References:

- https://flutterwave.com/eu/merchant-service-agreement
- https://www.flutterwave.com/us/support/general/updated-merchant-services-agreement-msa

Flutterwave's split-payment documentation also states that the marketplace owner is responsible for vetting its merchants and that disputes/chargebacks are logged against the marketplace owner's account.

Reference:

- https://developer.flutterwave.com/docs/split-payments

Flutterwave's support material includes an explicit aggregator/sub-merchant processing error for acquirers that do not support that functionality, which confirms that feature availability can depend on the acquiring setup.

Reference:

- https://www.flutterwave.com/us/support/general/common-transaction-errors

Therefore the connector fails closed unless the runtime account configuration carries:

```text
flutterwave.cm-marketplace-approved
```

This feature flag must represent actual Flutterwave/account approval. It must not be enabled merely because the public API endpoint exists.

## What is implemented

The foundation connector currently implements:

- Cameroon/XAF capability metadata;
- explicit commercial gating for `marketplace_accounts` and `split_payments`;
- collection subaccount request mapping;
- bank-account settlement destination only for collection subaccounts;
- Flutterwave Standard hosted payment creation;
- one-beneficiary split mapping;
- flat platform commission mapping;
- XAF Mobile Money checkout option;
- verify-by-reference;
- v3 webhook `verif-hash` verification;
- provider-neutral webhook status normalization;
- shared connector contract tests using an injected HTTP transport.

No fake provider transaction IDs or fake checkout URLs are generated by the connector.

## Deliberately not advertised yet

The connector does not currently declare:

- `payouts`;
- `refunds`;
- `settlement_status`.

Flutterwave publicly documents these capabilities in various forms, but they are outside this marketplace POC until their exact relationship to the Cameroon subaccount/settlement model is validated.

## Remaining live/sandbox gates

Before issue #7 can close:

- [ ] obtain/activate a Flutterwave test account for the Trigenys Cameroon business context;
- [ ] confirm marketplace/subaccount approval for that account;
- [ ] confirm that a Cameroon bank account can be registered as the collection subaccount settlement destination under this account/acquirer;
- [ ] confirm the exact KYB/KYC responsibility for each Zamari training centre;
- [ ] confirm that split funds settle directly according to the documented subaccount settlement cycle rather than requiring Trigenys to perform a second payout;
- [ ] run a real sandbox subaccount creation;
- [ ] run a real sandbox XAF Standard payment with the subaccount;
- [ ] verify the transaction through the authoritative verification endpoint;
- [ ] replay the real webhook and prove one logical state transition;
- [ ] record the observed fees, commission and settlement evidence.

## Current verdict

**CONDITIONAL GO.**

The technical architecture is supported by Flutterwave's public v3 APIs, and Cameroon/XAF/Mobile Money support is public. However, Zamari's exact marketplace operating model requires Flutterwave pre-approval and account/acquirer confirmation.

Do not mark Flutterwave as production-supported for Cameroon marketplace payments until those commercial and sandbox gates pass.
