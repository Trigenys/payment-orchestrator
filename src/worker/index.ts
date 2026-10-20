import { Pool } from "pg";
import { createInboxWorker, isInboxSchemaReady } from "./runtime.js";
import { readInboxRuntimeConfig, runtimeDatabaseUrl, runtimeEnabled } from "./configuration.js";
import { createInboxWorkerServer } from "./server.js";

/**
 * Distinct, private Cloud Run service entrypoint. Merely building this file or
 * running the existing public API never starts this worker.
 */
if (!runtimeEnabled(process.env, "PAYMENT_INBOX_WORKER_ENABLED", "CLOUD_RUN_INBOX_WORKER_ENABLED")) {
  throw new Error("Private inbox worker is disabled. No listener started.");
}

const connectionString = runtimeDatabaseUrl(process.env);
const config = readInboxRuntimeConfig(process.env);
const pool = new Pool({ connectionString, max: 5 });
const worker = createInboxWorker(pool, config);
const ready = async (): Promise<boolean> => {
  try { return await isInboxSchemaReady(pool); } catch { return false; }
};

const server = createInboxWorkerServer({ worker, ready });
const port = Number.parseInt(process.env.PORT || "8080", 10);
server.listen(port, process.env.HOST || "0.0.0.0", () => {
  console.log(JSON.stringify({
    level: "info", event: "worker.started",
    component: "fapshi-inbox", environment: config.environment, port
  }));
});

process.on("SIGTERM", () => {
  server.close(() => {
    void pool.end().then(() => process.exit(0)).catch(() => process.exit(1));
  });
});
