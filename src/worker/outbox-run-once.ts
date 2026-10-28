import { Pool } from "pg";
import type { LeasedOutboxDelivery } from "../storage/postgres/durable-messages.js";
import { PostgresMessageStore } from "../storage/postgres/durable-messages.js";
import { paymentEnvironment, requiredRuntimeValue, type RuntimeEnvironment } from "./configuration.js";
import { isInboxSchemaReady } from "./runtime.js";
import { PrecisOutboxWorker } from "./precis-outbox-worker.js";

export interface PrecisOutboxRuntimeConfig {
  readonly environment: "sandbox" | "live";
  readonly projectId: string;
  readonly endpoint: string;
  readonly keyId: string;
  readonly secret: string;
  readonly connectionString: string;
}

/** Explicit, separate environment-specific switches: disabled by default. */
export function readPrecisOutboxConfig(env: RuntimeEnvironment): PrecisOutboxRuntimeConfig {
  const environment = paymentEnvironment(env);
  const label = environment.toUpperCase();
  if (env[`PAYMENT_${label}_OUTBOX_ENABLED`] !== "true") {
    throw new Error("Précis outbox delivery is disabled.");
  }
  if (environment === "live" && env.PAYMENT_LIVE_OUTBOX_APPROVED !== "true") {
    throw new Error("Live Précis delivery requires explicit rollout approval.");
  }
  const required = (name: string) => requiredRuntimeValue(env, name);
  const secret = required(`PAYMENT_${label}_OUTBOX_HMAC_SECRET`);
  if (secret.length < 32) throw new Error("Précis outbox signing secret is too short.");
  return {
    environment,
    projectId: required(`PAYMENT_${label}_PROJECT_ID`),
    endpoint: required(`PAYMENT_${label}_PRECIS_EVENT_URL`),
    keyId: required(`PAYMENT_${label}_OUTBOX_KEY_ID`),
    secret,
    // Do not silently fall back to the legacy unscoped DATABASE_URL.
    connectionString: required(`PAYMENT_${label}_DATABASE_URL`)
  };
}

/** A persisted successful payment and its gross posting must both exist. */
export async function isOutboxPaymentVerified(
  pool: Pool, delivery: LeasedOutboxDelivery, environment: "sandbox" | "live"
): Promise<boolean> {
  const row = await pool.query<{
    status: string;
    payload: Record<string, unknown>;
    amount_minor: string;
    currency: string;
    external_reference: string;
    journaled: boolean;
  }>(
    `SELECT p.status, p.payload, p.amount_minor, p.currency,
            p.external_reference,
            EXISTS (
              SELECT 1 FROM payment_ledger_entries e
              WHERE e.payment_id=p.id AND e.project_id=p.project_id
                AND e.kind='payment_gross'
            ) AS journaled
     FROM payment_intents p
     WHERE p.id=$1 AND p.project_id=$2`,
    [delivery.paymentId, delivery.projectId]
  );
  const payment = row.rows[0];
  if (!payment || payment.status !== "succeeded" ||
      !payment.journaled || payment.payload?.provider !== "fapshi" ||
      payment.payload?.providerEnvironment !== environment ||
      payment.payload?.projectId !== delivery.projectId ||
      payment.payload?.providerReference !== delivery.payload.providerReference ||
      payment.external_reference !== delivery.payload.externalReference ||
      payment.currency !== delivery.payload.currency ||
      payment.amount_minor !== String(delivery.payload.amountMinor)) {
    return false;
  }
  return true;
}

/**
 * Private one-shot job, to run on the existing AWS host only after the
 * receiving Précis endpoint has its own durable signature verifier.
 * No network call is possible when the flag is absent/false.
 */
export async function runOutboxOnce(
  environment: RuntimeEnvironment = process.env,
  httpClient: typeof fetch = fetch
): Promise<void> {
  const config = readPrecisOutboxConfig(environment);
  const pool = new Pool({
    connectionString: config.connectionString, max: 2,
    connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 7000
  });
  try {
    if (!await isInboxSchemaReady(pool)) {
      throw new Error("Payment schema is not ready.");
    }
    const worker = new PrecisOutboxWorker({
      store: new PostgresMessageStore(pool), projectId: config.projectId,
      environment: config.environment, endpoint: config.endpoint,
      signingKey: { keyId: config.keyId, secret: config.secret },
      isVerifiedPayment: (delivery, mode) => isOutboxPaymentVerified(pool, delivery, mode),
      fetchImpl: httpClient
    });
    const result = await worker.runBatch(1);
    console.log(JSON.stringify({
      event: "payment.outbox.sweep", environment: config.environment,
      ...result
    }));
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("/worker/outbox-run-once.js")) {
  void runOutboxOnce().catch(() => {
    console.error(JSON.stringify({ event: "payment.outbox.sweep_failed" }));
    process.exitCode = 1;
  });
}
