import { createHash, timingSafeEqual } from "node:crypto";
import { Pool } from "pg";
import { createInboxWorker, isInboxSchemaReady, type InboxRuntimeConfig } from "../worker/runtime.js";
import type { WorkerBatchResult } from "../worker/fapshi-inbox-worker.js";

export interface InvocationRuntime {
  ready(): Promise<boolean>;
  runBatch(maximum: number): Promise<WorkerBatchResult>;
  close(): Promise<void>;
}

export type InvocationFactory = (env: PaymentInboxEnv, config: InboxRuntimeConfig) => InvocationRuntime;

/** New pool per invocation: Cloudflare sockets cannot cross request lifetimes. */
export const createInvocationRuntime: InvocationFactory = (env, config) => {
  const pool = new Pool({
    connectionString: env.HYPERDRIVE.connectionString,
    max: 2, connectionTimeoutMillis: 5000,
    statement_timeout: 5000, query_timeout: 7000
  });
  const worker = createInboxWorker(pool, config);
  return {
    ready: () => isInboxSchemaReady(pool),
    runBatch: maximum => worker.runBatch(maximum),
    close: () => pool.end()
  };
};

function configuration(env: PaymentInboxEnv): InboxRuntimeConfig | undefined {
  if (env.CLOUDFLARE_SANDBOX_INBOX_ENABLED !== "true") return undefined;
  const config = {
    // This existing deployment remains sandbox-only while its CPU gate is open.
    // The financial composition below is shared with the environment-aware AWS runtime.
    environment: "sandbox" as const,
    projectId: env.PAYMENT_SANDBOX_PROJECT_ID,
    merchantId: env.PAYMENT_SANDBOX_MERCHANT_ID,
    serviceName: env.FAPSHI_SANDBOX_SERVICE_NAME,
    apiuser: env.FAPSHI_SANDBOX_APIUSER,
    apikey: env.FAPSHI_SANDBOX_APIKEY
  };
  if (!env.HYPERDRIVE || Object.values(config).some(value => !value?.trim()) ||
      (env.PAYMENT_SANDBOX_INTERNAL_TOKEN?.length ?? 0) < 32) return undefined;
  return config;
}

export function isInternalAuthorized(request: Request, expected: string | undefined): boolean {
  if (!expected || expected.length < 32) return false;
  const supplied = request.headers.get("authorization");
  if (!supplied || supplied.length > 4096) return false;
  return timingSafeEqual(
    createHash("sha256").update(supplied).digest(),
    createHash("sha256").update(`Bearer ${expected}`).digest()
  );
}

function json(status: number, body: unknown): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" }
  });
}

/** Cloudflare can expose an empty POST as a non-null readable stream. */
export async function hasNonEmptyBody(request: Request): Promise<boolean> {
  const size = request.headers.get("content-length");
  if (size !== null && (!/^\d+$/.test(size) || Number(size) > 0)) return true;
  if (request.body === null) return false;
  const reader = request.body.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async () => {
      for (let i = 0; i < 16; i++) {
        const part = await reader.read();
        if (part.done) return false;
        if (part.value.byteLength > 0) return true;
      }
      return true;
    };
    return await Promise.race([
      read(), new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(true), 1000); })
    ]);
  } catch {
    return true;
  } finally {
    clearTimeout(timeout);
    void reader.cancel().catch(() => undefined);
  }
}

export async function handleInboxRequest(
  request: Request, env: PaymentInboxEnv, factory: InvocationFactory = createInvocationRuntime
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET") {
    return json(200, { status: "ok", sandbox: true, livePaymentsEnabled: false });
  }
  if (!["/ready", "/internal/fapshi-inbox/drain"].includes(url.pathname)) {
    return json(404, { error: "NOT_FOUND" });
  }
  const ready = url.pathname === "/ready";
  if (request.method !== (ready ? "GET" : "POST")) {
    return json(405, { error: "METHOD_NOT_ALLOWED" });
  }
  // Authenticate both database readiness and drain before opening any socket.
  if (!isInternalAuthorized(request, env.PAYMENT_SANDBOX_INTERNAL_TOKEN)) {
    return json(401, { error: "UNAUTHORIZED" });
  }
  if (url.search || await hasNonEmptyBody(request)) {
    return json(400, { error: "BODY_OR_QUERY_NOT_ALLOWED" });
  }
  const config = configuration(env);
  if (!config) return json(503, { error: "SANDBOX_INBOX_NOT_CONFIGURED" });
  let runtime: InvocationRuntime | undefined;
  try {
    runtime = factory(env, config);
    if (!await runtime.ready()) return json(503, { error: "SANDBOX_SCHEMA_NOT_READY" });
    if (ready) return json(200, { status: "ready", sandbox: true, livePaymentsEnabled: false });
    // One lease per invocation until real Cloudflare CPU measurements allow more.
    return json(200, await runtime.runBatch(1));
  } catch {
    return json(503, { error: "SANDBOX_WORKER_UNAVAILABLE" });
  } finally {
    if (runtime) await runtime.close().catch(() => undefined);
  }
}

export async function runScheduledInbox(
  env: PaymentInboxEnv, factory: InvocationFactory = createInvocationRuntime
): Promise<WorkerBatchResult | undefined> {
  if (env.CLOUDFLARE_SANDBOX_INBOX_ENABLED !== "true") return undefined;
  const config = configuration(env);
  if (!config) throw new Error("SANDBOX_INBOX_NOT_CONFIGURED");
  const runtime = factory(env, config);
  try {
    if (!await runtime.ready()) throw new Error("SANDBOX_SCHEMA_NOT_READY");
    return await runtime.runBatch(1);
  } catch {
    // Generic error records an unsuccessful Cron invocation without secrets.
    throw new Error("SANDBOX_INBOX_SWEEP_FAILED");
  } finally {
    await runtime.close().catch(() => undefined);
  }
}

export default {
  fetch(request: Request, env: PaymentInboxEnv): Promise<Response> {
    return handleInboxRequest(request, env);
  },
  async scheduled(_controller: ScheduledController, env: PaymentInboxEnv): Promise<void> {
    await runScheduledInbox(env);
  }
};
