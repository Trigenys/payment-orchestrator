import { paymentEnvironment, readInboxRuntimeConfig, runtimeDatabaseUrl, runtimeEnabled, runtimeSecret } from "./worker/configuration.js";
import { Pool } from "pg";
import { createFapshiRoutes } from "./api/fapshi-routes.js";
import { FapshiHostedClient } from "./providers/fapshi/client.js";
import { FapshiHostedConnector } from "./providers/fapshi/connector.js";
import { FetchProviderHttpClient } from "./providers/http.js";
import { createServiceServer } from "./server.js";
import { PostgresMessageStore } from "./storage/postgres/durable-messages.js";
import { FapshiConfirmation } from "./storage/postgres/fapshi-confirmation.js";

const port = Number.parseInt(process.env.PORT || "3000", 10);
const host = process.env.HOST || "0.0.0.0";

// Health-only unless explicitly enabled. Environment selects credentials and DB;
// no consumer request can choose or change the configured environment.
const apiEnabled = runtimeEnabled(process.env, "PAYMENT_API_ENABLED", "PAYMENT_SANDBOX_API_ENABLED");
const routes = apiEnabled ? (() => {
  const config = readInboxRuntimeConfig(process.env);
  const { environment, projectId, merchantId, serviceName: expectedServiceName, apiuser, apikey } = config;
  const connectionString = runtimeDatabaseUrl(process.env);
  const webhookSecret = runtimeSecret(process.env, "WEBHOOK_SECRET");
  const internalApiToken = runtimeSecret(process.env, "INTERNAL_TOKEN");
  const pool = new Pool({ connectionString, max: 10 });
  const connector = new FapshiHostedConnector({
    client: new FapshiHostedClient({
      environment,
      httpClient: new FetchProviderHttpClient(),
      getCredentials: async () => ({ apiuser, apikey })
    }),
    projectId, merchantId, expectedServiceName
  });
  return createFapshiRoutes({
    environment, pool, projectId, merchantId, expectedServiceName,
    webhookSecret, internalApiToken,
    messageStore: new PostgresMessageStore(pool),
    confirmation: new FapshiConfirmation({
      environment, pool, projectId, merchantId, expectedServiceName, connector
    })
  });
})() : undefined;

const server = createServiceServer({
  name: "payment-orchestrator",
  version: "0.1.0"
}, routes);

server.listen(port, host, () => {
  console.log(JSON.stringify({
    level: "info",
    event: "service.started",
    service: "payment-orchestrator",
    host,
    port,
    paymentApiEnabled: apiEnabled,
    paymentEnvironment: apiEnabled ? paymentEnvironment(process.env) : undefined
  }));
});
