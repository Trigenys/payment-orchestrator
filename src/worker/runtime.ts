import type { Pool } from "pg";
import { reserveFapshiStatusRead } from "../api/fapshi-status-budget.js";
import { FapshiHostedClient } from "../providers/fapshi/client.js";
import { FapshiHostedConnector } from "../providers/fapshi/connector.js";
import { FetchProviderHttpClient, type ProviderHttpClient } from "../providers/http.js";
import { FapshiConfirmation } from "../storage/postgres/fapshi-confirmation.js";
import { parseFapshiEnvironment } from "../providers/fapshi/environment.js";
import type { InboxRuntimeConfig } from "./configuration.js";
export type { InboxRuntimeConfig } from "./configuration.js";
import { FapshiInboxWorker } from "./fapshi-inbox-worker.js";
import { PostgresInboxWorkerStore } from "./inbox-persistence.js";

/** Shared composition; neither imports a listener nor starts a loop. */
export function createInboxWorker(
  pool: Pool,
  config: InboxRuntimeConfig,
  httpClient: ProviderHttpClient = new FetchProviderHttpClient()
): FapshiInboxWorker {
  parseFapshiEnvironment(config.environment);
  if (Object.values(config).some(value => !value.trim())) {
    throw new Error("Inbox configuration is incomplete.");
  }
  const connector = new FapshiHostedConnector({
    client: new FapshiHostedClient({
      environment: config.environment,
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
    store: new PostgresInboxWorkerStore(pool, config.serviceName, config.environment),
    confirmation: new FapshiConfirmation({
      environment: config.environment,
      pool, projectId: config.projectId, merchantId: config.merchantId,
      expectedServiceName: config.serviceName, connector
    }),
    reserveStatusRead: reference => reserveFapshiStatusRead(pool, reference, config.environment)
  });
}

/** Legacy sandbox entrypoint; delegates to the shared environment-aware composition. */
export function createSandboxInboxWorker(
  pool: Pool, config: Omit<InboxRuntimeConfig, "environment">,
  httpClient?: ProviderHttpClient
): FapshiInboxWorker {
  return createInboxWorker(pool, { ...config, environment: "sandbox" }, httpClient);
}

export async function isInboxSchemaReady(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ n: number }>(
    `SELECT COUNT(DISTINCT version)::int AS n
     FROM schema_migrations WHERE version = ANY($1::text[])`,
    [["001_payment_core", "002_financial_persistence", "003_message_delivery",
      "004_fapshi_verify_budget", "005_inbox_worker", "006_fapshi_environments"]]
  );
  return result.rows[0]?.n === 6;
}
