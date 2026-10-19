import { Client } from "pg";
import { handleCloudflareProbe } from "./probe.js";

const requiredMigrations = [
  "001_payment_core", "002_financial_persistence", "003_message_delivery",
  "004_fapshi_verify_budget", "005_inbox_worker"
];

/** Read-only connectivity probe; it cannot create or confirm payments. */
export async function checkSandboxDatabase(env: PaymentProbeEnv): Promise<boolean> {
  const client = new Client({
    connectionString: env.HYPERDRIVE.connectionString,
    connectionTimeoutMillis: 5000,
    query_timeout: 5000
  });
  try {
    await client.connect();
    const result = await client.query<{ version: string }>(
      "SELECT version FROM schema_migrations WHERE version = ANY($1::text[])",
      [requiredMigrations]
    );
    return requiredMigrations.every(version => result.rows.some(row => row.version === version));
  } finally {
    await client.end();
  }
}

export async function handleCloudflareDatabaseProbe(
  request: Request,
  env: PaymentProbeEnv,
  checkDatabase = checkSandboxDatabase
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== "/ready") {
    return handleCloudflareProbe(request);
  }
  let databaseConnected = false;
  try {
    databaseConnected = await checkDatabase(env);
  } catch {
    // Never expose driver errors: they can contain hostnames or credentials.
  }
  return Response.json({
    status: "not_ready",
    reason: databaseConnected ? "sandbox_payment_runtime_not_enabled" : "sandbox_database_not_ready",
    sandbox: true,
    databaseConnected,
    paymentsEnabled: false
  }, {
    status: 503,
    headers: {
      "cache-control": "no-store",
      "x-content-type-options": "nosniff"
    }
  });
}

export default {
  fetch(request: Request, env: PaymentProbeEnv): Promise<Response> {
    return handleCloudflareDatabaseProbe(request, env);
  }
};
