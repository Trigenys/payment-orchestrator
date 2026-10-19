import type { Pool } from "pg";
import { reserveFapshiSandboxStatusRead } from "../api/fapshi-status-budget.js";
import { FapshiHostedClient } from "../providers/fapshi/client.js";
import { FapshiHostedConnector } from "../providers/fapshi/connector.js";
import { FetchProviderHttpClient, type ProviderHttpClient } from "../providers/http.js";
import { FapshiSandboxConfirmation } from "../storage/postgres/fapshi-confirmation.js";
import { FapshiInboxWorker } from "./fapshi-inbox-worker.js";
import { PostgresInboxWorkerStore } from "./inbox-persistence.js";

export interface InboxRuntimeConfig {
  readonly projectId: string;
  readonly merchantId: string;
  readonly serviceName: string;
  readonly apiuser: string;
  readonly apikey: string;
}

/** Shared composition; neither imports a listener nor starts a loop. */
export function createSandboxInboxWorker(
  pool: Pool,
  config: InboxRuntimeConfig,
  httpClient: ProviderHttpClient = new FetchProviderHttpClient()
): FapshiInboxWorker {
  if (Object.values(config).some(value => !value.trim())) {
    throw new Error("Sandbox inbox configuration is incomplete.");
  }
  const connector = new FapshiHostedConnector({
    client: new FapshiHostedClient({
      httpClient,
      getCredentials: async () => ({ apiuser: config.apiuser, apikey: config.apikey })
    }),
    projectId: config.projectId,
    merchantId: config.merchantId,
    expectedServiceName: config.serviceName
  });
  return new FapshiInboxWorker({
    projectId: config.projectId,
    merchantId: config.merchantId,
    store: new PostgresInboxWorkerStore(pool, config.serviceName),
    confirmation: new FapshiSandboxConfirmation({
      pool, projectId: config.projectId, merchantId: config.merchantId,
      expectedServiceName: config.serviceName, connector
    }),
    reserveStatusRead: reference => reserveFapshiSandboxStatusRead(pool, reference)
  });
}

export async function isInboxSchemaReady(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ n: number }>(
    `SELECT COUNT(DISTINCT version)::int AS n
     FROM schema_migrations WHERE version = ANY($1::text[])`,
    [["001_payment_core", "002_financial_persistence", "003_message_delivery",
      "004_fapshi_verify_budget", "005_inbox_worker"]]
  );
  return result.rows[0]?.n === 5;
}
