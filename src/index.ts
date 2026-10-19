import { Pool } from "pg";
import { createFapshiSandboxRoutes } from "./api/fapshi-sandbox-routes.js";
import { FapshiHostedClient } from "./providers/fapshi/client.js";
import { FapshiHostedConnector } from "./providers/fapshi/connector.js";
import { FetchProviderHttpClient } from "./providers/http.js";
import { createServiceServer } from "./server.js";
import { PostgresMessageStore } from "./storage/postgres/durable-messages.js";
import { FapshiSandboxConfirmation } from "./storage/postgres/fapshi-confirmation.js";

const port = Number.parseInt(process.env.PORT || "3000", 10);
const host = process.env.HOST || "0.0.0.0";

function required(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) {
    throw new Error(`Sandbox runtime requires ${name}. No routes activated.`);
  }
  return value.trim();
}

// Default remains health-only. No payments, callbacks or data stores are
// connected unless the operator EXPLICITLY enables the sandbox adapter.
const sandboxEnabled = process.env.PAYMENT_SANDBOX_API_ENABLED === "true";

const routes = sandboxEnabled ? (() => {
  const connectionString = required("DATABASE_URL");
  const projectId = required("PAYMENT_SANDBOX_PROJECT_ID");
  const merchantId = required("PAYMENT_SANDBOX_MERCHANT_ID");
  const expectedServiceName = required("FAPSHI_SANDBOX_SERVICE_NAME");
  const webhookSecret = required("FAPSHI_SANDBOX_WEBHOOK_SECRET");
  const internalApiToken = required("PAYMENT_SANDBOX_INTERNAL_TOKEN");
  const apiuser = required("FAPSHI_SANDBOX_APIUSER");
  const apikey = required("FAPSHI_SANDBOX_APIKEY");

  const pool = new Pool({ connectionString, max: 10 });
  const connector = new FapshiHostedConnector({
    client: new FapshiHostedClient({
      httpClient: new FetchProviderHttpClient(),
      getCredentials: async () => ({ apiuser, apikey })
    }),
    projectId,
    merchantId,
    expectedServiceName
  });
  return createFapshiSandboxRoutes({
    pool,
    projectId,
    merchantId,
    expectedServiceName,
    webhookSecret,
    internalApiToken,
    messageStore: new PostgresMessageStore(pool),
    confirmation: new FapshiSandboxConfirmation({
      pool,
      projectId,
      merchantId,
      expectedServiceName,
      connector
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
    sandboxApiEnabled: sandboxEnabled
  }));
});
