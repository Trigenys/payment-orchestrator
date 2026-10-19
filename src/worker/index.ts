import { Pool } from "pg";
import { createSandboxInboxWorker, isInboxSchemaReady } from "./runtime.js";
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
const worker = createSandboxInboxWorker(pool, {
  projectId, merchantId, serviceName, apiuser, apikey
});
const ready = async (): Promise<boolean> => {
  try { return await isInboxSchemaReady(pool); } catch { return false; }
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
