import { Pool } from "pg";
import { createSandboxInboxWorker, isInboxSchemaReady, type InboxRuntimeConfig } from "./runtime.js";

/** Private one-shot entrypoint for an existing server/container, with no HTTP listener. */
export async function runOnce(environment: Readonly<Record<string, string | undefined>> = process.env): Promise<void> {
  if (environment.PAYMENT_SANDBOX_SWEEP_ENABLED !== "true") {
    throw new Error("Sandbox sweep is disabled.");
  }
  const required = (name: string): string => {
    const value = environment[name]?.trim();
    if (!value) throw new Error(`Sandbox sweep requires ${name}.`);
    return value;
  };
  const config: InboxRuntimeConfig = {
    projectId: required("PAYMENT_SANDBOX_PROJECT_ID"),
    merchantId: required("PAYMENT_SANDBOX_MERCHANT_ID"),
    serviceName: required("FAPSHI_SANDBOX_SERVICE_NAME"),
    apiuser: required("FAPSHI_SANDBOX_APIUSER"),
    apikey: required("FAPSHI_SANDBOX_APIKEY")
  };
  const pool = new Pool({ connectionString: required("DATABASE_URL"), max: 2,
    connectionTimeoutMillis: 5000, statement_timeout: 5000, query_timeout: 7000 });
  try {
    if (!await isInboxSchemaReady(pool)) throw new Error("Sandbox schema is not ready.");
    const summary = await createSandboxInboxWorker(pool, config).runBatch(1);
    console.log(JSON.stringify({ event: "sandbox.inbox.sweep", ...summary }));
  } finally {
    await pool.end();
  }
}

if (process.argv[1]?.endsWith("/worker/run-once.js")) {
  void runOnce().catch(() => {
    console.error(JSON.stringify({ event: "sandbox.inbox.sweep_failed" }));
    process.exitCode = 1;
  });
}
