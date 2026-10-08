# Trigenys Payment Orchestrator

Provider-agnostic payment orchestration for African payment rails.

The project gives Trigenys applications one stable payment contract while PSP-specific details stay behind connectors.

> Status: foundation / feasibility phase. No provider is production-supported yet.

## Target

```text
Zamari / other Trigenys products
        |
        +-- TypeScript SDK
        |       |
        +-------+----> REST API v1
                       |
                       v
                Orchestration core
                - projects
                - merchants
                - payments
                - idempotency
                - webhooks
                - ledger mirror
                - reconciliation
                       |
             +---------+---------+
             |         |         |
        Flutterwave  CinetPay  Notch Pay ...
```

The PSP remains responsible for actual payment collection and settlement. This service must not become a pooled-funds wallet or custodian by accident.

## Core identities

- **Project** — the consuming application, e.g. Zamari.
- **Merchant** — the economic beneficiary, e.g. a training centre.
- **ProviderAccount** — that merchant's external identity at a PSP.
- **Payment** — Trigenys' provider-neutral payment intent/state.
- **LedgerEntry** — immutable accounting/reconciliation evidence, not a spendable balance.

## V1

- capability-driven provider contract;
- normalized payments and merchant accounts;
- idempotent write operations;
- signed webhook ingestion;
- Flutterwave marketplace POC;
- CinetPay White Label capability validation;
- ledger/reconciliation primitives;
- REST API v1;
- TypeScript SDK;
- Zamari as first real consumer.

See [RAIDER audit](docs/RAIDER-AUDIT.md), [provider capability contract](docs/provider-contract.md), [payment state machine](docs/payment-state-machine.md), [security threat model](docs/security/threat-model.md), [Flutterwave Cameroon feasibility](docs/providers/flutterwave-cameroon.md), [CinetPay Cameroon / White Label feasibility](docs/providers/cinetpay-cameroon.md), [Notch Pay Sync capability audit](docs/providers/notchpay-sync.md) and [ecosystem audit](docs/ecosystem-audit.md).

See [TypeScript SDK contract](docs/sdk-typescript.md).\n\n## Runtime

The AppFactory foundation currently uses:

- Node.js 24;
- TypeScript;
- native Node HTTP bootstrap;
- Node test runner;
- AppFactory Project Automation.

Hosting, database and queue are intentionally not selected yet. They will follow measured workload and security requirements instead of being hard-coded by the generator.

## Development

```bash
npm install
npm run check
npm run dev
```

Current endpoint:

- `GET /health`

## Public status

The repository is public for development visibility. **No open-source license has been selected yet**, so public visibility must not be interpreted as permission to redistribute the code.

## Engineering standard

This repository follows Trigenys RAIDER. Read `AGENTS.md` and `docs/engineering/lessons-learned.md` before risky changes.
