/**
 * Non-financial Cloudflare Workers bootstrap.
 *
 * Deliberately does not import payment/ledger/PSP modules. This diagnostic
 * proves the Cloudflare edge deployment can be reached without a database,
 * credentials, billable database resources or a production checkout.
 * Replace ONLY after an isolated sandbox PostgreSQL and cache-disabled
 * Hyperdrive binding have been configured and integration tests pass.
 */
const commonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
};

export function handleCloudflareProbe(request: Request): Response {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return new Response(JSON.stringify({
      status: "ok",
      service: "trigenys-payment-orchestrator",
      runtime: "cloudflare-workers",
      sandbox: true,
      paymentsEnabled: false,
      databaseConnected: false
    }), { status: 200, headers: commonHeaders });
  }
  if (request.method === "GET" && url.pathname === "/ready") {
    return new Response(JSON.stringify({
      status: "not_ready",
      reason: "sandbox_database_not_configured",
      paymentsEnabled: false
    }), { status: 503, headers: commonHeaders });
  }
  return new Response(JSON.stringify({ error: "NOT_FOUND" }), {
    status: 404,
    headers: commonHeaders
  });
}

export default {
  fetch(request: Request): Response {
    return handleCloudflareProbe(request);
  }
};
