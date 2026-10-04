# Architecture

## System boundary

```text
Consumer application
   |
   | project API key / service identity
   v
+-----------------------------+
| Payment Orchestrator API    |
+-----------------------------+
   |
   v
+-----------------------------+
| Application / domain core   |
|                             |
| Project                     |
| Merchant                    |
| ProviderAccount             |
| Payment                     |
| Refund                      |
| Settlement                  |
| Ledger / Reconciliation     |
+-----------------------------+
   |
   | provider-neutral ports
   v
+-----------------------------+
| Connector adapters          |
| Flutterwave / CinetPay /... |
+-----------------------------+
   |
   v
External PSPs
```

## Identity separation

### Project

Represents a consuming application such as Zamari. It owns API access policy and environment configuration.

### Merchant

Represents the economic beneficiary of a payment. A Zamari training centre is a Merchant.

### ProviderAccount

Represents the PSP-specific merchant/subaccount/connected-account identity. Provider IDs are external references and must never become Trigenys domain primary keys.

One Merchant may have multiple ProviderAccounts over time or across providers.

## Provider capability model

Connectors declare capabilities instead of forcing every provider into a false common denominator.

Example capability vocabulary:

```ts
type Capability =
  | "collect"
  | "mobile_money"
  | "refunds"
  | "payouts"
  | "marketplace_accounts"
  | "split_payments"
  | "settlement_status";
```

A requested operation fails closed when the provider/environment/country/currency does not advertise the required capability.

## Money boundary

The orchestrator records and reconciles monetary state but does not own the underlying customer or merchant funds.

V1 must not implement:
- pooled merchant balances;
- arbitrary internal transfers between merchants;
- cash-in/cash-out wallets;
- a card vault.

Use PSP-hosted checkout/tokenization and PSP settlement flows.

## Monetary representation

All domain amounts use integer minor units together with an explicit ISO currency. Connectors own provider-specific amount conversions where a provider contract differs.

Never use binary floating-point for ledger amounts.

## Idempotency

Every externally triggered write has a stable logical key.

At minimum:
- payment creation: `project_id + idempotency_key`;
- provider event: `provider + environment + provider_event_id`;
- ledger posting: deterministic source key + posting kind;
- merchant onboarding: project/merchant/provider/environment identity.

Replays converge rather than creating another logical financial operation.

## Webhooks

Webhook adapters:
1. read raw request bytes;
2. verify provider signature/authentication;
3. persist a unique provider event receipt;
4. normalize the event;
5. apply an idempotent domain transition;
6. acknowledge according to provider retry semantics.

Unknown/out-of-order events are retained for reconciliation instead of silently discarded.

## Ledger and reconciliation

The ledger is an append-only accounting mirror used to explain:
- gross amount;
- PSP fees where known;
- merchant share;
- Trigenys/application commission;
- refunds/adjustments;
- settlement status.

It is **not** a wallet balance that Trigenys promises to redeem.

Reconciliation compares internal state with authoritative PSP transaction/settlement records and emits discrepancies.

## API + SDK

REST is the canonical external contract.

The TypeScript SDK is a thin client over REST. It must not contain business rules that are absent from the API service.

Target versioning starts at `/v1` only when the first contract is frozen. Until then, the repository remains pre-release.

## Deployment

No hosting/database/queue choice is locked at foundation stage.

The selection must support:
- transactional/idempotent writes;
- append-only financial records;
- encrypted secrets;
- scheduled reconciliation;
- durable webhook processing;
- audit logs;
- least-privilege deployment.

## Evolution gates

1. local/domain contract tests;
2. provider sandbox connector;
3. Zamari adapter;
4. second distinct consumer;
5. production threat model + regulatory review;
6. only then broader external/self-service productization.
