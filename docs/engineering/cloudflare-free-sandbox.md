# Cloudflare Free sandbox bootstrap

Status: **probe-only**; no payment runtime or credentials deployed.

## Why this follows the Cloud Run branch

- Existing Cloudflare account already has Workers. No new Google Cloud
  billing account or card is required for a diagnostic Worker.
- Cloudflare's **Workers Free** limit is **10 ms CPU per HTTP request and
  per scheduled trigger**. PostgreSQL I/O wait does not count as CPU, but
  cryptography and domain/ledger logic do. We **cannot assume** the full
  payment worker meets this limit: measure it with a separate isolated
  sandbox and abort if it exceeds the quota.
- Hyperdrive Free includes 100,000 SQL statements per day and supports
  PostgreSQL transaction pooling and `pg`, but **Hyperdrive query cache
  MUST be disabled** for payment/accounting reads.
- A wholly separate sandbox Neon project/branch and Hyperdrive binding
  are mandatory. **DO NOT reuse existing Commerce Factory, Product
  Identity, Insight or SEO Monitor production connections.** A
  production payment database is not created here.

## Probe

`npx wrangler deploy --config wrangler.payment-probe.jsonc`

Only supports:
- GET /health -> 200 and `paymentsEnabled=false`
- GET /ready -> 503
- Everything else -> 404

No HTTP webhook, status verification, queue, PSP secrets, scheduled trigger,
database binding or payment code is deployed.

## Next gates before turning on any sandbox processing

1. Confirm no paid add-on is activated. Set up a separate project in
   Neon **Free** and a dedicated database, least-privilege role and backups.
2. Configure a separate Hyperdrive binding with `--caching-disabled`
   connected only to that isolated database. Never expose the DSN in
   GitHub, Workers source, comments or screenshots.
3. Adapt `PaymentService`, fenced PostgreSQL claims, the Fapshi
   confirmation unit-of-work and worker to the Cloudflare `fetch` and
   `scheduled` runtime. No `node:http` server or Docker container.
4. Build with Wrangler and run an end-to-end test with an isolated DB;
   test real `pg_advisory_xact_lock`, `BEGIN`/`COMMIT`, Hyperdrive
   fresh reads, concurrent retries and consumer deduplication.
5. Measure execution CPU against Free 10ms; if exceeded, use only
   Cloudflare for authenticated ingress and host the **financial
   processor elsewhere**. Do not silently switch to a paid plan.
6. Production-grade backup/restore, PSP sandbox/live approval and
   signed Précis notifications remain separate go/no-go checks.

Reference: https://developers.cloudflare.com/workers/platform/limits/
Reference: https://developers.cloudflare.com/hyperdrive/platform/pricing/
Reference: https://developers.cloudflare.com/hyperdrive/concepts/query-caching/
