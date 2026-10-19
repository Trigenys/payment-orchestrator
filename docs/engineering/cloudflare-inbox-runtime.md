# Cloudflare inbox runtime and deployed contract test

## Outcome — 2026-10-19

The shared inbox processor runs on Cloudflare and Neon through cache-disabled
Hyperdrive. A fixed, simulated PSP transport confirmed a test payment, wrote one
ledger batch and one outbox notification. Replaying a SUCCESSFUL observation
processed the second inbox record without a second financial effect.

**The financial processor is NOT approved for Workers Free:** Cloudflare
observability reported **35 ms** for the first confirmation and **22 ms** for
the replay, exceeding the documented **10 ms** Free CPU budget. HTTP 200 during
this diagnostic is not proof that later requests will stay within quota.
No paid plan was activated. Billing-plan reads are unavailable to the connected
OAuth integration, so an existing paid subscription was not assumed.

The deployed `trigenys-payment-sandbox-inbox` remains disabled and has no cron.
There are no Fapshi credentials in that Worker. The original diagnostic remains
separate and read-only. The contract test is a distinct, authenticated Worker
with a simulated provider, never imported by the real runtime; its public
workers.dev route is disabled after the test.

## Shared implementation

`src/worker/runtime.ts` composes the existing lease worker, shared PostgreSQL
PSP-read budget and atomic payment/ledger/outbox confirmation. Both the existing
Cloud Run entrypoint and Cloudflare use this composition. No Node HTTP listener
is imported by Cloudflare.

`src/cloudflare/inbox-runtime.ts` creates a pool inside each invocation, limits
it to two sockets and one inbox lease, awaits all processing, then closes the
pool. Failed processing remains recoverable via the existing SQL leases/retry
schedule. No per-isolate timer loop or global database connection is used.

- GET `/health`: no database access; live payments always disabled.
- GET `/ready`: internal bearer token, full configuration and migrated schema required.
- POST `/internal/fapshi-inbox/drain`: same authentication; no body or query
  parameters; exactly one bounded sweep.
- Cron handler: same composition and cleanup, generic failure reported to
  Cloudflare. No cron is configured or activated while the CPU gate fails.
- Other paths, including checkout creation and webhooks, stay 404.

`wrangler.payment-inbox.jsonc` declares the disabled runtime and required secret
names. `wrangler.payment-contract.jsonc` is the separate deployed-test entrypoint.
Generate each configuration's types before a dry-run build.

## Database permissions

The inbox uses a separate SQL-managed role `payments_sandbox_inbox` and
Hyperdrive `cc9af5ddfa4545708f876c334aba5280`, with query caching disabled and
origin connection limit 5. It connects only to the isolated sandbox project.

The role cannot create roles, databases, schemas or tables and does not inherit
`neon_superuser`. It has SELECT on identities/schema versions, SELECT/INSERT/
UPDATE on payment intents and the inbox, and SELECT/INSERT on reservations,
bindings, events, transitions, ledger, outbox and status-read budget. Ledger
UPDATE/DELETE are not granted. Sequence USAGE is limited to the two existing
identity sequences. The original probe's role remains read-only.

## Recorded deployed test

Fixed project: `cloudflare-contract-test`; fixed merchant:
`cloudflare-contract-merchant`. These are simulated test identities, not Précis.
The transport makes **no external PSP calls** and returns a fixed 150 XAF
collection with 140 XAF revenue. The values are fixture data, not money collected.

1. `/setup` created an idempotent test payment/binding and durable inbox entry.
2. `/drain` claimed and processed one event through the real PostgreSQL adapters.
3. `/audit` returned `succeeded`, one ledger batch and one outbox message.
4. `/replay` queued a distinct callback observation for the same PSP reference.
5. `/drain` processed it; final audit retained one ledger batch and one outbox
   message, with two processed inbox observations.

Recorded contract script version: `d8a7bf35-a739-430d-8bc2-dcb436683298`.
No Précis credits were granted and no outbox notification was dispatched.

## Next deployment path without a new paid subscription

Keep Cloudflare for small authenticated ingress. Run the financial sweep on the
existing application server in a separate restricted container after checking
its available capacity and obtaining the actual Fapshi sandbox credentials.
`src/worker/run-once.ts` is a private one-shot entrypoint for this purpose; it
opens no HTTP port and uses the same coordinator and persisted retry state:

```sh
docker build -f Dockerfile.worker -t trigenys-payment-inbox:sandbox .
docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --env-file /etc/trigenys/payment-sandbox-inbox.env \
  trigenys-payment-inbox:sandbox node dist/src/worker/run-once.js
```

The protected server-only environment needs `PAYMENT_SANDBOX_SWEEP_ENABLED=true`,
the sandbox DATABASE_URL and the five identity/credential fields used by the
existing worker. Never put that file in GitHub or expose it through the UI.
Do not install an always-on minute poller merely for testing: it can prevent
Neon scale-to-zero and consume the free compute allowance. A bounded test sweep
comes first; the durable wake-up/ingress strategy must be costed before scheduling.

Actual Fapshi sandbox verification, webhook ingress, lost-webhook reconciliation,
signed outgoing delivery, Précis entitlement matching and live rollout are still
separate unfinished gates in #24, #27, #29 and #30.

Reference: https://developers.cloudflare.com/workers/platform/limits/
