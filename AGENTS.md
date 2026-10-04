# Agent instructions

This repository follows the Trigenys RAIDER engineering standard.

Changes must remain reusable, configuration-driven, provider-agnostic, replay-safe for financial state, non-regressive, least-privilege, testable and adoptable by existing consumers.

Before risky changes, review `docs/engineering/lessons-learned.md`. Significant failures or near misses require a root-cause note and a proportionate prevention mechanism.

## Payment invariants

- Never log or commit PSP secrets.
- Never store PAN/CVV or introduce a card vault without an explicit security/compliance decision.
- Never represent money with binary floating-point values.
- Never claim a connector capability that is not implemented and tested.
- Never process an unverified webhook as authoritative.
- Duplicate requests/events must not duplicate financial effects.
- Project, Merchant and ProviderAccount identities remain separate.
- Trigenys ledger state is an accounting/reconciliation mirror, not an internal customer wallet.
- Provider-specific vocabulary stays in connector adapters.
- Public API/SDK breaking changes require versioning and migration guidance.
