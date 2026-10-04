# Notch Pay Sync — marketplace capability audit

Date checked: 2026-10-04  
Decision: **GO for architecture; connector implementation conditional on Sync enablement and endpoint confirmation**

## Why this spike matters

Notch Pay Sync is the first provider reviewed whose public developer documentation directly describes the same marketplace concepts used by Payment Orchestrator:

- connected merchant accounts;
- merchant onboarding and KYC;
- split payments;
- platform fees;
- payouts to connected accounts;
- sandbox connected accounts;
- account/payment/transfer webhooks.

This is stronger evidence than a marketing page alone.

## Connected accounts

The Sync guide states that platforms and marketplaces can manage payments for multiple connected accounts.

Connected accounts can:

- receive payments through the platform;
- access their own dashboard;
- receive payouts to bank or Mobile Money accounts;
- customize payment settings.

The detailed account-management guide documents API-driven connected-account creation.

Documented route:

```text
POST https://api.notchpay.co/sync/accounts
```

with account types:

- `standard`;
- `express`;
- `custom`.

The Custom account model is explicitly described as white-labelled and platform-managed.

References:

- https://developer.notchpay.co/sync/index
- https://developer.notchpay.co/sync/account-management

## KYC / onboarding

The public Sync documentation includes a connected-account onboarding flow:

1. platform creates the connected account;
2. platform generates an onboarding link;
3. seller completes identity/business verification;
4. seller configures bank or Mobile Money payout details;
5. account status/capabilities are updated after verification.

Documented onboarding route:

```text
POST /sync/accounts/{accountId}/onboarding
```

The public guide lists KYC inputs including identity documents, proof of address, business registration details and tax identification information.

Notch Pay therefore owns the connected-account verification workflow, while the platform is responsible for initiating onboarding and monitoring requirements/status.

Reference:

- https://developer.notchpay.co/sync/account-management

## Split payments and platform commission

The Sync integration guide documents automatic payment splitting using:

```json
{
  "amount": 10000,
  "currency": "XAF",
  "application_fee": 1000,
  "destination": {
    "account": "<connected-account-id>",
    "amount": 9000
  }
}
```

It also documents percentage and combined fee models.

This maps cleanly to the Payment Orchestrator model:

```text
gross amount
- merchant allocation
= platform application fee
```

References:

- https://developer.notchpay.co/sync/integration

## Payouts / merchant settlement

Sync documentation states that connected accounts can receive payouts to bank accounts or Mobile Money accounts.

It describes:

- automatic payout schedules;
- manual payouts;
- batch payouts;
- payout reporting.

The merchant agreement also states that settlement funds may be held during the settlement period and that merchants can specify third-party beneficiaries for transfers.

References:

- https://developer.notchpay.co/sync/index
- https://notchpay.co/policies/merchant-agreement

This is enough to validate the provider capability conceptually, but not enough to implement `settlement_status` in our connector until the exact API contract for payout/settlement retrieval is mapped and tested.

## Sandbox

Notch Pay has a real test/live separation.

The public testing guide documents:

- Sandbox/Test Mode with no real money;
- test API keys beginning with `pk_test_`;
- Cameroon Mobile Money test numbers;
- MTN, Orange, EU Mobile and Yoomee test channels.

The Sync integration guide explicitly instructs platforms to:

- create test connected accounts;
- process test payments;
- test fee structures;
- create test transfers;
- verify webhooks before going live.

References:

- https://developer.notchpay.co/get-started/testing
- https://developer.notchpay.co/sync/integration

## Webhooks

Notch Pay documents HMAC-SHA256 webhook verification using:

```text
x-notch-signature
```

with the account's webhook hash.

The Sync guide identifies events including:

- `account.created`;
- `account.updated`;
- `account.application.deauthorized`;
- `payment.succeeded`;
- `payment.failed`;
- `transfer.created`;
- `transfer.complete`;
- `transfer.failed`.

Reference:

- https://developer.notchpay.co/get-started/webhooks/verify
- https://developer.notchpay.co/sync/integration

## Cameroon collection

The public testing documentation includes Cameroon-specific Mobile Money channels and test numbers.

The public payment API documents XAF payments and an explicit `locked_country: "CM"` option. The Mobile Money guide uses Cameroon/XAF examples.

References:

- https://developer.notchpay.co/get-started/testing
- https://developer.notchpay.co/api-reference/initialize-a-payment
- https://developer.notchpay.co/accept-payments/mobile-money

## Capability map against Payment Orchestrator

| Orchestrator capability | Public Notch Pay evidence | Decision |
| --- | --- | --- |
| `collect` | Payments API / Collect | Supported conceptually |
| `mobile_money` | Cameroon test channels + Mobile Money docs | Supported conceptually |
| `marketplace_accounts` | Sync connected accounts API | Supported, requires Sync-enabled account |
| `split_payments` | destination + application_fee | Supported, requires Sync-enabled account |
| `payouts` | Sync payouts to bank/Mobile Money | Supported conceptually; connector endpoint mapping still required |
| `refunds` | public refunds guide exists | Out of this Sync spike |
| `settlement_status` | reporting/payout concepts documented | Do not advertise until exact API mapping exists |

## Important documentation inconsistency

The current public Sync docs are not perfectly consistent about account route prefixes.

Examples encountered:

- detailed Account Management guide: `/sync/accounts`;
- some examples in the Sync Integration guide: `/accounts`.

That is exactly the kind of ambiguity RAIDER requires us to resolve before coding a production connector.

Therefore we do **not** hard-code a Notch Pay Sync account endpoint yet. The canonical route must be confirmed by:

1. a Sync-enabled test account and successful sandbox request; or
2. direct Notch Pay technical confirmation / current API reference.

## Commercial gate

The Sync landing guide explicitly says to contact Notch Pay sales to enable Sync and complete compliance requirements.

Runtime marketplace capability must therefore eventually be gated by something equivalent to:

```text
notchpay.sync-enabled
```

The existence of public docs must not be treated as proof that every ordinary merchant account has Sync enabled.

## Current verdict

**GO for the Payment Orchestrator architecture.**

Notch Pay Sync validates our core separation of:

- Project;
- Merchant;
- ProviderAccount;
- split payment allocation;
- platform commission;
- merchant onboarding/KYB;
- provider-specific payout capability.

**Conditional for connector implementation.**

Before writing the real Sync connector, obtain a test account with Sync enabled and confirm the canonical account/onboarding endpoints. Once that is available, Notch Pay is currently the cleanest documented candidate for proving the full marketplace flow in sandbox.
