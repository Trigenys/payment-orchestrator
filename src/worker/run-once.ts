import { Pool } from "pg";
import { createInboxWorker, isInboxSchemaReady } from "./runtime.js";
import { readInboxRuntimeConfig, runtimeDatabaseUrl, runtimeEnabled } from "./configuration.js";

/** Private one-shot entrypoint for an existing server/container, with no HTTP listener. */
export async function runOnce(environment: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  if (!runtimeEnabled(environment, "PAYMENT_SWEEP_ENABLED", "PAYMENT_SANDBOX_SWEEP_ENABLED")) {
    throw new Error("Payment sweep is disabled.");
  }
  const config = readInboxRuntimeConfig(environment);
  const pool = new Pool({ connectionString: runtimeDatabaseUrl(environment), max: 2,
    connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 7000 });
  try {
    if (!await isInboxSchemaReady(pool)) throw new Error("Payment schema is not ready.");
    const summary = await createInboxWorker(pool, config).runBatch(1);
    console.log(JSON.stringify({ event: "payment.inbox.sweep", environment: config.environment, ...summary }));
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("/worker/run-once.js")) {
  void runOnce().catch(() => {
    console.error(JSON.stringify({ event: "payment.inbox.sweep_failed" }));
    process.exitCode = 1;
  });
}
