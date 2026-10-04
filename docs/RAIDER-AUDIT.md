# RAIDER audit — Payment Orchestrator

Date: 2026-10-04  
Status: **GO, staged and conditional**

## Executive decision

A shared payment orchestration layer is technically feasible and has a strong reuse case across Trigenys products. The project should start as a **server-side orchestration service + versioned REST API + TypeScript SDK**, with Zamari as the first real consumer.

The V1 must **not** become a payment institution by design. It must not pool customer funds, expose an internal spendable wallet, or settle merchants from a Trigenys-held balance. The payment service provider remains the party that actually collects and settles funds. Trigenys stores orchestration state, provider references and an accounting/reconciliation mirror.

A developer dashboard, smart routing, multi-provider failover and public third-party onboarding are later phases. They are not prerequisites for proving the core.

## Feasibility

### Technical: high

The core problem is proven by existing payment orchestration products. Hyperswitch demonstrates the value of a connector-based orchestration kernel, routing and reconciliation. Flutterwave documents subaccounts and split payments for marketplace-style use. CinetPay documents a white-label model that allows a partner to aggregate merchants, collect payments, perform merchant reversals and reconcile transactions. Notch Pay documents REST APIs, webhooks, sandbox support and a Sync capability for managing multiple merchant accounts.

The unresolved question is not whether orchestration is possible. It is **which capabilities are commercially enabled for each provider in Cameroon/XAF, under what KYB and settlement rules**.

### Regulatory: conditional

CEMAC payment services are regulated under Regulation No. 04/18/CEMAC/UMAC/COBAC. The regulation applies to payment service providers and also refers to technical partners and distributors. Before an external hosted product is offered to third parties, the exact legal classification of Trigenys' role must be reviewed.

Architecture reduces the risk surface by keeping custody and settlement with licensed/approved PSPs, but this is not a substitute for legal analysis.

### Security: feasible with a narrow boundary

V1 should:
- never store PAN/CVV or raw card data;
- prefer PSP-hosted checkout/tokenization;
- keep provider credentials server-side only;
- verify webhook signatures against the raw payload;
- make all write paths replay-safe;
- maintain an immutable financial event/ledger history;
- separate project, merchant and provider-account identities;
- avoid secrets and sensitive KYB data in logs.

## Reuse-first decision

### Adopt

Use PSP-native payment collection, merchant/KYB and settlement capabilities rather than recreating financial rails.

Use hosted checkout/tokenization wherever practical.

### Adapt / learn

- **Hyperswitch**: connector boundaries, capability abstraction, routing, reconciliation and observability.
- **pay-kit**: lightweight TypeScript normalization patterns for Flutterwave/Paystack, webhook handling and split-payment ergonomics.

Neither should become an unexamined hard dependency of the Trigenys domain model.

### Build

Build only the layer that is specific to the Trigenys/African multi-provider problem:

- provider capability contract;
- normalized payment, merchant and settlement state;
- connector ports/adapters;
- idempotency;
- normalized webhooks;
- ledger/reconciliation mirror;
- REST API;
- TypeScript SDK;
- consumer/project authentication.

## RAIDER assessment

### R — Reusable

**Target: pass.**

The orchestration core must be independent of Zamari. A consumer application is a `Project`; an economic beneficiary is a `Merchant`; an external PSP identity is a `ProviderAccount`. These are different concepts and must never collapse into one table/type.

Proof requires at least two distinct consumers before the abstraction is considered generally reusable.

### A — Agnostic

**Target: pass with capability-driven adapters.**

Business code asks for capabilities such as:

- `collect`
- `mobile_money`
- `marketplace_accounts`
- `split_payments`
- `refunds`
- `payouts`
- `settlement_status`

It must not ask whether a provider has a field named `subaccount_id`. Provider vocabulary stays inside connectors.

Country, currency, payment method and commercial enablement are runtime/provider capability data, not global assumptions.

### I — Idempotent

**Mandatory before any real money path.**

- create-payment requires a consumer idempotency key;
- provider event IDs are unique;
- duplicate webhooks cannot double-transition or double-post;
- merchant onboarding is replay-safe;
- retries return/reconcile the same logical operation where possible;
- ledger posting is deterministic and protected against duplication.

No production connector is considered complete without replay tests.

### D — Durable / non-regressive

**Mandatory before public SDK/API use.**

- version external API contracts;
- version SDK contracts;
- use connector contract tests;
- keep provider-specific changes behind adapter boundaries;
- do not silently reinterpret amounts, currencies or statuses;
- preserve consumer compatibility or publish a migration path.

The failure-memory log is `docs/engineering/lessons-learned.md`.

### E — Engineering-grade

Required controls:

- least-privilege service credentials;
- secret storage abstraction and key rotation plan;
- webhook signature verification on raw bytes;
- audit trail for financial state transitions;
- append-only ledger entries;
- structured redacted logs;
- timeout/retry/circuit-breaker policy per connector;
- reconciliation jobs;
- explicit monetary integer/subunit representation;
- UTC timestamps plus provider timestamps retained;
- threat model before production;
- no provider marketed as supported while its adapter is a stub.

### Scoped execution

CI should eventually distinguish:

- core/domain;
- each connector;
- API transport;
- SDK;
- persistence/ledger;
- docs/dashboard.

Connector-only changes should not wake unrelated connector suites. Core contract changes must fan out to all connector contract tests.

### Reuse-first

Passed at discovery stage: ecosystem research was performed before implementation. The decision is to **adapt established orchestration patterns, not clone an existing global gateway and not rebuild PSP rails**.

### R — Retroactive

Zamari must migrate through a compatibility/anti-corruption layer. Its current local payment abstraction should not be deleted in one destructive rewrite.

Migration target:

```text
Zamari domain
   -> Zamari payment port
      -> Trigenys TypeScript SDK
         -> Payment Orchestrator API
            -> provider connector
```

A second distinct consumer is required before declaring the shared abstraction stable.

## V1 scope

1. provider capability registry;
2. project + merchant + provider-account model;
3. normalized payment state machine;
4. idempotency contract;
5. normalized signed webhooks;
6. Flutterwave connector POC;
7. CinetPay white-label capability spike/connector path;
8. append-only ledger and reconciliation primitives;
9. REST API v1;
10. TypeScript SDK;
11. Zamari integration.

## Explicitly out of V1

- Trigenys-held customer balances;
- merchant wallet/custody;
- card vault;
- chargeback automation;
- smart routing/ML;
- public self-service merchant onboarding;
- multi-region active-active infrastructure;
- polished developer dashboard;
- Python/mobile SDKs.

## Go / no-go gates

The project can proceed to a real sandbox payment only when:

- the target provider confirms Cameroon/XAF capability for the required marketplace flow;
- merchant/KYB ownership is explicit;
- money settlement does not rely on Trigenys custody;
- webhook verification and idempotency are implemented;
- amounts/fees/commission are traceable in the ledger mirror;
- provider secrets are outside source control;
- the connector has contract + replay tests.

External production use requires a regulatory/legal review of the hosted operating model.
