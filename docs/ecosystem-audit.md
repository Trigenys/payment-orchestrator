# Ecosystem and provider feasibility audit

Date: 2026-10-04

This audit follows the RAIDER reuse-first rule: **Adopt / Adapt / Learn / Build** before writing a new payment stack.

## Hyperswitch

Reference: https://hyperswitch.io/

Hyperswitch is a mature open-source payment orchestration platform with modular connectors, routing, reconciliation and self-hosted/managed deployment options.

Decision: **Learn, do not fork for V1.**

Why:
- validates the orchestration architecture;
- useful reference for connector boundaries, routing and reconciliation;
- substantially larger scope than the first Trigenys requirement;
- Rust/full-stack adoption would introduce significant operational weight;
- the Cameroon-focused provider set required by Trigenys still needs independent validation.

## pay-kit

Reference: https://github.com/siyegs/pay-kit

A lightweight TypeScript SDK that normalizes Paystack and Flutterwave flows and documents charge, verification, refund, payout, webhooks, reconciliation, fallback and marketplace split support.

Decision: **Adapt/learn.**

Useful for:
- Flutterwave request/response mapping patterns;
- normalized TypeScript contracts;
- webhook ergonomics;
- sandbox test ideas.

Do not expose its types as Trigenys public domain types. It is an implementation reference/optional adapter dependency, not the product boundary.

## Flutterwave

References:
- https://developer.flutterwave.com/docs/split-payments
- https://developer.flutterwave.com/docs/flutterwave-standard-1

Public documentation supports marketplace-style subaccounts and split settlement/commission concepts.

Decision: **Primary technical POC candidate.**

Open gate:
- confirm that the exact marketplace/subaccount/split flow is commercially enabled for a Cameroon-registered Trigenys account and Cameroonian beneficiaries in XAF;
- confirm supported settlement destinations and KYB requirements.

Do not infer Cameroon commercial enablement from generic API documentation.

## CinetPay

Reference: https://cinetpay.com/legal/cgu-services

CinetPay's White Label terms explicitly describe a partner aggregating merchants, APIs for collecting payments and making merchant reversals, plus reporting and reconciliation.

Decision: **Strong regional candidate; commercial/private API validation required.**

Open gates:
- merchant onboarding/KYB lifecycle;
- API-level merchant creation;
- settlement ownership;
- automated platform commission;
- Cameroon payout destinations;
- sandbox/private partner documentation and pricing.

## Notch Pay

References:
- https://developer.notchpay.co/
- https://notchpay.co/

Notch Pay documents REST APIs, webhooks, sandbox use, payments/transfers and a Sync capability for multiple merchant accounts.

Decision: **Capability spike, not assumed marketplace support.**

Open gate:
- obtain concrete Sync APIs/contracts for merchant onboarding, payment attribution, split/commission and settlement.

## CamPay

Decision: **Direct-payment fallback candidate only until marketplace capabilities are proven.**

No marketplace capability should be declared from the current Zamari placeholder adapter.

## Regulatory references

- BEAC / COBAC Regulation No. 04/18/CEMAC/UMAC/COBAC:
  https://www.beac.int/systemes-paiement/instructions-circulaires-reglements/
- COBAC regulations:
  https://www.beac.int/supervision-bancaire/reglements-de-cobac/

The hosted service boundary must be reviewed before external production use. The design goal is orchestration rather than custody, but technical-partner obligations may still apply.

## Build decision

Build a thin Trigenys orchestration layer because the requirement is the intersection of:

- Cameroon/CEMAC rails;
- provider portability;
- marketplace/merchant capabilities;
- normalized Trigenys project integration;
- idempotency and reconciliation;
- a small SDK ergonomics layer.

Do **not** build a payment network, card vault, wallet or settlement institution.
