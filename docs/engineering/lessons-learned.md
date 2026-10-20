# Engineering lessons learned

This file is the RAIDER failure-memory log for Payment Orchestrator.

## 2026-10-04 — Bootstrap opened a premature 1.0.0 release PR

### Context and impact

The generic AppFactory service blueprint included a release workflow triggered on every push to `main`. The AppFactory bootstrap commit used a conventional `feat` message, so Release Please immediately opened a `1.0.0` release PR even though the product had no frozen API or provider implementation.

No release was merged or published.

### Root cause

A generic generator embedded a product-level release policy before the product had declared its versioning/readiness policy.

### Resolution

The generated release PR was closed. Payment Orchestrator release automation is manual-only until the public API/SDK contract is explicitly frozen.

### Prevention

Generic service blueprints should avoid automatic semantic releases from bootstrap commits. Release automation must be opt-in or manual until a generated product chooses its release policy.

### General lesson

Repository scaffolding may provide release *mechanics*, but it must not infer release *readiness*.

---

## 2026-10-19 — Managed role creation defaults to administrative privileges

Neon's API-created Postgres role was automatically a member of
`neon_superuser`, with CREATEDB/CREATEROLE. The existing database owner
could not strip those managed grants. This was discovered by inspecting
`pg_roles` and `pg_auth_members` before deploying the database-bound probe.
No Worker used the overprivileged connection.

Created a separate SQL-managed `payments_worker` role with NOINHERIT,
NOCREATEDB, NOCREATEROLE, NOREPLICATION and NOBYPASSRLS. Granted only
CONNECT, schema USAGE and SELECT on migration versions for the probe,
updated Hyperdrive, then removed the unused API-created role.

Prevention: inspect effective grants and role memberships before binding
any managed database role to a deployed Worker. A dedicated role name
alone does not demonstrate least privilege.

---

## 2026-10-19 — An empty Cloudflare POST can have a body stream

The first deployed contract probe rejected empty authenticated POST requests
because it treated any non-null Request.body as content. Local Request fixtures
had null bodies, masking the platform difference. No database writes occurred
in those rejected requests.

The shared guard now checks an empty stream with a bounded read, rejects actual
content and times out stalled bodies. Added a regression test with a closed
empty ReadableStream, then reran the deployed contract flow successfully.
Platform-boundary tests must include stream shapes observed in production.

The same deployment measured 35 ms / 22 ms CPU for financial confirmation /
replay despite HTTP 200. These exceed the documented Workers Free budget.
The regular processor and cron remain off; successful responses are not a
substitute for checking platform resource limits. See the inbox-runtime report.

---

## 2026-10-20 — A pilot environment leaked into reusable runtime logic

The Fapshi pilot fixed sandbox in the client origin, capability profile,
confirmation, SQL claims and verification-budget constraint. Having a live
service would have required changes at every layer instead of configuration.
No live keys were installed and no live payment was made.

Root cause: sandbox rollout gating was encoded as provider/domain behavior.
The common transport, coordinator and worker now take one explicit environment;
entrypoints select only that environment's credentials, identities and database.
Legacy sandbox entrypoints delegate to the shared implementation. Migration 006
preserves sandbox attempts while allowing an independently scoped live budget.

Prevention: contract tests cover both modes, missing live configuration and
cross-environment calls. PostgreSQL tests deliberately reuse a PSP reference and
service name across modes to prove inbox, binding, quota and effect isolation.
An account's availability and a deployment's activation belong in configuration,
not in a fork of the payment algorithm.

---

Future meaningful failures and near misses must record:
- context and impact;
- root cause;
- resolution;
- recurrence-prevention guardrail;
- generalized lesson when applicable.
