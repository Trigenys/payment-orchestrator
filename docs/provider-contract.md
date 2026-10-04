# Provider capability contract

Status: foundation contract for issue #4.

## Purpose

The core never assumes that two payment providers expose the same product vocabulary or that a capability available globally is enabled for a Cameroon account.

A connector declares **capabilities**, and each capability may be constrained by:

- environment (`sandbox` / `live`);
- country;
- currency;
- commercial account feature flags.

A provider operation is allowed only when every capability required by that operation is supported in the supplied context.

## Capability vocabulary

The initial shared vocabulary is:

- `collect`
- `mobile_money`
- `refunds`
- `payouts`
- `marketplace_accounts`
- `split_payments`
- `settlement_status`

These are Trigenys concepts. Provider-specific words stay inside concrete adapters.

## Core identities

### Project

A consuming application/service, for example Zamari.

### Merchant

The economic beneficiary of a payment.

### ProviderAccount

The external PSP identity associated with a Merchant for one provider/environment.

The provider's own ID is stored as `externalAccountId`; it is not the Trigenys domain primary key.

### Payment

A provider-neutral payment record linked to a Project and Merchant, with an optional ProviderAccount.

### Refund

A provider-neutral refund against a Payment.

### Settlement

The observed PSP settlement state for a Merchant/ProviderAccount.

## Money

`Money` uses:

```ts
interface Money {
  amountMinor: number;
  currency: string;
}
```

`amountMinor` must be a JavaScript safe integer. Binary floating-point amounts such as `10.25` are rejected by the factory. Currency is normalized to an uppercase three-letter code.

Examples:

- XAF 10,000 → `{ amountMinor: 10000, currency: "XAF" }`
- USD 10.25 → `{ amountMinor: 1025, currency: "USD" }`

Provider adapters own any provider-specific conversion.

## Capability examples

A provider can declare collection only for sandbox Cameroon/XAF:

```ts
{
  capability: "collect",
  environments: ["sandbox"],
  countries: ["CM"],
  currencies: ["XAF"]
}
```

A marketplace feature may additionally require commercial enablement:

```ts
{
  capability: "split_payments",
  environments: ["sandbox", "live"],
  countries: ["CM"],
  currencies: ["XAF"],
  requiresCommercialFeatures: ["marketplace-enabled"]
}
```

That flag must come from verified provider/account configuration. It must never be inferred merely from generic provider documentation.

## Fail-closed behavior

Unsupported operations return a normalized error:

```ts
{
  ok: false,
  error: {
    code: "capability_unsupported",
    provider: "...",
    retryable: false,
    message: "...",
    details: {
      rejected: [...]
    }
  }
}
```

The rejection details explain whether the missing dimension is:

- capability declaration;
- environment;
- country;
- currency;
- commercial feature.

## Payment capability composition

Payment creation always requires `collect`.

Additionally:

- `channel: "mobile_money"` requires `mobile_money`;
- supplying allocations requires `split_payments`.

This allows core business logic to ask for behavior instead of inspecting PSP names.

## Connector contract test kit

`test/support/provider-contract.ts` exposes `runProviderContractSuite`.

Every real provider adapter must run the same shared suite, then add provider-specific tests for:

- request/response mapping;
- signatures/webhooks;
- provider error translation;
- sandbox fixtures;
- country/currency/account capability evidence.

The in-memory `MockProviderConnector` currently passes the shared suite and is the reference implementation for contract behavior. It is not a production provider.
