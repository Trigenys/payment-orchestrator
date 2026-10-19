import { Pool } from "pg";
import { reserveFapshiSandboxStatusRead } from "../api/fapshi-status-budget.js";
import { FapshiHostedClient } from "../providers/fapshi/client.js";
import { FapshiHostedConnector } from "../providers/fapshi/connector.js";
import { FetchProviderHttpClient } from "../providers/http.js";
import { FapshiSandboxConfirmation } from "../storage/postgres/fapshi-confirmation.js";
import { FapshiInboxWorker } from "./fapshi-inbox-worker.js";
import { PostgresInboxWorkerStore } from "./inbox-persistence.js";
import { createInboxWorkerServer } from "./server.js";

/**
 * Distinct, private Cloud Run service entrypoint. Merely building this file or
 * running the existing public API never starts this worker.
 */
if (process.env.CLOUD_RUN_INBOX_WORKER_ENABLED !== "true") {
  throw new Error("Private inbox worker is disabled. No listener started.");
}

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Inbox worker requires ${name}.`);
  }
  return value.trim();
}

const connectionString = required("DATABASE_URL");
const projectId = required("PAYMENT_SANDBOX_PROJECT_ID");
const merchantId = required("PAYMENT_SANDBOX_MERCHANT_ID");
const serviceName = required("FAPSHI_SANDBOX_SERVICE_NAME");
const apiuser = required("FAPSHI_SANDBOX_APIUSER");
const apikey = required("FAPSHI_SANDBOX_APIKEY");

const pool = new Pool({ connectionString, max: 5 });
const connector = new FapshiHostedConnector({
  client: new FapshiHostedClient({
    httpClient: new FetchProviderHttpClient(),
    getCredentials: async () => ({ apiuser, apikey })
  }),
  projectId, merchantId, expectedServiceName: serviceName
});

const worker = new FapshiInboxWorker({
  projectId, merchantId,
  store: new PostgresInboxWorkerStore(pool, serviceName),
  confirmation: new FapshiSandboxConfirmation({
    pool, projectId, merchantId, expectedServiceName: serviceName, connector
  }),
  reserveStatusRead: providerReference =>
    reserveFapshiSandboxStatusRead(pool, providerReference)
});

const ready = async (): Promise<boolean> => {
  try {
    const result = await pool.query<{ n: number }>(
      `SELECT COUNT(DISTINCT version)::int AS n
       FROM schema_migrations WHERE version = ANY($1::text[])`,
      [[
        "001_payment_core",
        "002_financial_persistence",
        "003_message_delivery",
        "004_fapshi_verify_budget",
        "005_inbox_worker"
      ]]
    );
    return result.rows[0]?.n === 5;
  } catch {
    return false;
  }
};

const server = createInboxWorkerServer({ worker, ready });
const port = Number.parseInt(process.env.PORT || "8080", 10);
server.listen(port, process.env.HOST || "0.0.0.0", () => {
  console.log(JSON.stringify({
    level: "info", event: "worker.started",
    component: "fapshi-sandbox-inbox", port
  }));
});

process.on("SIGTERM", () => {
  server.close(() => {
    void pool.end().then(() => process.exit(0)).catch(() => process.exit(1));
  });
});
