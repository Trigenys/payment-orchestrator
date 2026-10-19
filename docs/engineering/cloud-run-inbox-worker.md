# Cloud Run — private Fapshi sandbox inbox worker

Status: **implemented in code; NOT deployed**. Changes to paid Google Cloud
resources, DNS, the existing public webhook receiver, or live Fapshi account
are **not** part of this PR.

## Architecture

The public Payment Orchestrator API (already present) receives an authenticated
Fapshi webhook and persists a privacy-filtered event in PostgreSQL. The
**separate** request-driven Cloud Run inbox worker executes:

1. Claim at most three due records from the inbox with PostgreSQL
   `FOR UPDATE SKIP LOCKED`, a lease expiry and fencing token.
2. Ignore `FAILED` or `EXPIRED` as **payment proof**; record the notification
   as observed and leave payment state untouched (Fapshi `FAILED` may not be
   the final state of the underlying collection).
3. For a `SUCCESSFUL` claim, find the provider reference **only within the
   configured project/merchant**. Never trust the webhook's claimed amount,
   order, user, or account.
4. Reserve one PSP status read in the existing shared PostgreSQL budget
   (5 reads / rolling 60 seconds / provider reference).
5. Invoke the existing `FapshiSandboxConfirmation` coordinator, which fetches
   the PSP's authenticated status and atomically writes payment + financial
   ledger + outbox only if it matches the stored intent.
6. ACK the inbox record under the still-current lease. Errors are persisted
   with exponential retry; after six failed attempts, quarantine for an
   operator to inspect. A denied PSP budget is deferred for 75 seconds
   **without consuming an attempt**.
7. On a Cloud Run crash, another worker may reclaim the expired lease;
   duplicate confirmations cannot duplicate financial effects.

The worker is **not** a perpetual loop; it only works while the authenticated
HTTP invocation is running. This suits request-based Cloud Run billing and
zero minimum instances.

## Container and endpoint

Build with `docker build -f Dockerfile.worker -t IMAGE .`. The image
executes `node dist/src/worker/index.js` on port `8080`.

| Endpoint | Behavior |
| --- | --- |
| `GET /health` | Liveness, no database queries |
| `GET /ready` | Ready only when migrations 001–005 exist |
| `POST /internal/fapshi-inbox/drain` | Empty body; claims up to 3 pending inbox events |

The worker has **no public webhook route** and **no public checkout route**.
It must run as its own Cloud Run service with **Require authentication** and
**no allUsers Cloud Run Invoker grant**. Cloud Run IAM validates the Google OIDC
token before the application receives the request. Request headers alone are
not an authentication method.

The startup has an explicit fail-closed switch:

```ini
CLOUD_RUN_INBOX_WORKER_ENABLED=true
DATABASE_URL=<isolated sandbox PostgreSQL DSN from Secret Manager>
PAYMENT_SANDBOX_PROJECT_ID=<provisioned project>
PAYMENT_SANDBOX_MERCHANT_ID=<provisioned merchant>
FAPSHI_SANDBOX_SERVICE_NAME=<exact sandbox service label>
FAPSHI_SANDBOX_APIUSER=<sandbox credential from Secret Manager>
FAPSHI_SANDBOX_APIKEY=<sandbox credential from Secret Manager>
PORT=8080
```

Provision the database and apply `npm run db:migrate` in a separate controlled
job **before starting** the worker. Run it with a distinct least-privilege
service account. Ensure PostgreSQL access from Cloud Run; if using a private
database, configure an appropriate private egress path, not a world-open
database port.

## Recommended Google Cloud setup (illustrative; do NOT execute automatically)

- Cloud Run worker: request-based billing, minimum instances 0, concurrency 1,
  maximum instances 2, timeout 180 seconds; authenticated invocations only.
- Cloud Scheduler: authenticated `POST` to the worker's
  `/internal/fapshi-inbox/drain` endpoint every minute; OIDC service account
  granted `roles/run.invoker` on the **worker service alone**.
- Optional Cloud Tasks: enqueue additional authenticated invocations of that
  same endpoint after receiving a webhook. This PR does **not** create tasks
  or a queue: Scheduler covers polling and crash recovery even if a task is
  never produced.
- Cloud Tasks / Scheduler OIDC **audience must be the service's base URL**,
  not the endpoint path. Use one service account per trigger where practical.
- Rate-limit Fapshi at database level; multiple worker replicas cannot bypass
  the current per-reference budget.
- Configure alerting for `quarantined` inbox records, `dead_letter` outbox
  records, failed Scheduler deliveries, stale leases and PostgreSQL errors.
- Test restore/redeployment against an **isolated** database and secrets.
  Schedule retention/archive cleanup of old `fapshi_status_attempts` and
  processed inbox history after confirming legal and audit requirements.

### Example: authenticated Scheduler trigger (after deployment)

```sh
gcloud run services add-iam-policy-binding WORKER_SERVICE_NAME \
  --region=REGION --member=serviceAccount:INVOKER_SA@PROJECT.iam.gserviceaccount.com \
  --role=roles/run.invoker

gcloud scheduler jobs create http payment-sandbox-inbox-sweep \
  --location=REGION --schedule='* * * * *' \
  --uri='https://WORKER_URL.run.app/internal/fapshi-inbox/drain' \
  --http-method=POST \
  --oidc-service-account-email='INVOKER_SA@PROJECT.iam.gserviceaccount.com' \
  --oidc-token-audience='https://WORKER_URL.run.app'
```

**Before provisioning:** choose the GCP project, region close to the
PostgreSQL server, credential storage and an explicit small spending budget
with alerts. Run `gcloud run services get-iam-policy` to confirm that
`allUsers` and `allAuthenticatedUsers` are **not** invokers.

## Not done in this phase

- Signed outbox dispatch and consumer-side exactly-once purchase recognition
  in Précis (still required before any credits).
- PSP initialization / checkout public API and real dashboard credentials.
- Continuous collection reconciliation when a Fapshi webhook is lost: a
  separate scheduled sweep over unsettled payment **intents** is still needed.
- Real sandbox network callbacks, staging deployment, IAM hardening review,
  restore drill and then independent live go/no-go.

**No live collections, no credits, no Cloud resources created.**

References:
- https://docs.cloud.google.com/run/docs/triggering/using-tasks
- https://docs.cloud.google.com/run/docs/triggering/using-scheduler
- https://docs.cloud.google.com/run/docs/configuring/billing-settings
