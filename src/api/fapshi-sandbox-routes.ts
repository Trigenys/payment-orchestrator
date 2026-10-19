import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Pool } from "pg";
import type { FapshiSandboxConfirmation } from "../storage/postgres/fapshi-confirmation.js";
import type { PostgresMessageStore } from "../storage/postgres/durable-messages.js";
import { reserveFapshiSandboxStatusRead } from "./fapshi-status-budget.js";

const WEBHOOK_PATH = "/v1/webhooks/fapshi/sandbox";
const PAYMENT_PATH = /^\/v1\/sandbox\/payments\/([A-Za-z0-9_:-]{1,160})(\/confirm)?$/;
const BODY_LIMIT = 8192;

export interface SandboxApiOptions {
  readonly pool: Pool;
  readonly projectId: string;
  readonly merchantId: string;
  readonly expectedServiceName: string;
  readonly webhookSecret: string;
  readonly internalApiToken: string;
  readonly messageStore: Pick<PostgresMessageStore, "recordInbox">;
  readonly confirmation: Pick<FapshiSandboxConfirmation, "confirm">;
  /** Defaults to PostgreSQL-backed reservation. Injectable in route tests. */
  readonly reserveStatusRead?: (providerReference: string) => Promise<boolean>;
}

function json(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(data));
}

function digest(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

/** Compares SHA-256 hashes so even length mismatches take constant-time equality. */
function secretEquals(supplied: unknown, expected: string): boolean {
  if (typeof supplied !== "string" || !supplied) return false;
  const actual = createHash("sha256").update(supplied).digest();
  const correct = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actual, correct);
}

function hasExactlyOneHeader(request: IncomingMessage, headerName: string): boolean {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2) {
    if (request.rawHeaders[i]?.toLowerCase() === headerName) count++;
  }
  return count === 1;
}

class BodyTooLargeError extends Error {}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const size = request.headers["content-length"];
  if (size && Number(size) > BODY_LIMIT) {
    request.resume();
    throw new BodyTooLargeError("Request too large.");
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > BODY_LIMIT) {
      request.resume();
      throw new BodyTooLargeError("Request too large.");
    }
    chunks.push(buffer);
  }
  let data: unknown;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new SyntaxError("Invalid JSON.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new SyntaxError("Expected a JSON object.");
  }
  return data as Record<string, unknown>;
}

/**
 * Registered only when the explicitly opt-in sandbox runtime is configured.
 * Webhook requests are authenticated, validated and persisted, NOT promoted to
 * a successful collection. Verification is an independent authenticated action.
 */
export function createFapshiSandboxRoutes(options: SandboxApiOptions) {
  if (options.webhookSecret.length < 32 || options.internalApiToken.length < 32 ||
      !options.expectedServiceName.trim() || !options.projectId || !options.merchantId) {
    throw new Error("Sandbox API requires explicit identity and 32+ byte secrets.");
  }
  const reserve = options.reserveStatusRead ??
    ((transId: string) => reserveFapshiSandboxStatusRead(options.pool, transId));

  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    if (request.url === "/ready") {
      if (request.method !== "GET") {
        json(response, 405, { error: "METHOD_NOT_ALLOWED" });
        return true;
      }
      try {
        const check = await options.pool.query<{ n: number }>(
          `SELECT COUNT(DISTINCT version)::int AS n FROM schema_migrations
           WHERE version = ANY($1::text[])`,
          [[
            "001_payment_core",
            "002_financial_persistence",
            "003_message_delivery",
            "004_fapshi_verify_budget"
          ]]
        );
        json(response, check.rows[0]?.n === 4 ? 200 : 503, {
          status: check.rows[0]?.n === 4 ? "ready" : "unavailable"
        });
      } catch {
        json(response, 503, { status: "unavailable" });
      }
      return true;
    }

    if (request.url === WEBHOOK_PATH) {
      if (request.method !== "POST") {
        json(response, 405, { error: "METHOD_NOT_ALLOWED" });
        return true;
      }
      if (!hasExactlyOneHeader(request, "x-wh-secret") ||
          !secretEquals(request.headers["x-wh-secret"], options.webhookSecret)) {
        json(response, 401, { error: "UNAUTHORIZED" });
        return true;
      }
      if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers["content-type"] ?? "")) {
        json(response, 415, { error: "UNSUPPORTED_MEDIA_TYPE" });
        return true;
      }
      let body: Record<string, unknown>;
      try {
        body = await readJson(request);
      } catch (error) {
        json(response, error instanceof BodyTooLargeError ? 413 : 400, {
          error: error instanceof BodyTooLargeError ? "PAYLOAD_TOO_LARGE" : "INVALID_JSON"
        });
        return true;
      }
      const transId = body.transId;
      const status = body.status;
      const service = body.serviceName;
      const transType = body.transType;
      if (typeof transId !== "string" ||
          !/^[A-Za-z0-9_-]{1,160}$/.test(transId) ||
          !["SUCCESSFUL", "FAILED", "EXPIRED"].includes(status as string) ||
          transType !== "Collection" ||
          service !== options.expectedServiceName) {
        json(response, 422, { error: "UNSUPPORTED_FAPSHI_EVENT" });
        return true;
      }
      const externalId = typeof body.externalId === "string" &&
        /^[A-Za-z0-9_-]{1,100}$/.test(body.externalId)
        ? body.externalId : undefined;
      const amount = Number.isSafeInteger(body.amount) && (body.amount as number) >= 0
        ? body.amount as number : undefined;
      const revenue = Number.isSafeInteger(body.revenue) && (body.revenue as number) >= 0
        ? body.revenue as number : undefined;
      const financialTransId = typeof body.financialTransId === "string" &&
        /^[A-Za-z0-9_-]{1,160}$/.test(body.financialTransId)
        ? body.financialTransId : undefined;
      const normalized = {
        transId, status: status as string, transType: "Collection",
        serviceName: options.expectedServiceName,
        ...(externalId ? { externalId } : {}),
        ...(amount !== undefined ? { amount } : {}),
        ...(revenue !== undefined ? { revenue } : {}),
        ...(financialTransId ? { financialTransId } : {})
      };
      const eventFingerprint = digest(JSON.stringify({
        transId, status, financialTransId: financialTransId ?? null
      }));
      try {
        const receipt = await options.messageStore.recordInbox({
          provider: "fapshi", environment: "sandbox",
          providerReference: transId, eventFingerprint,
          payloadDigest: digest(JSON.stringify(normalized)),
          payload: normalized
        });
        json(response, 200, {
          status: "received", replayed: receipt.replayed
        });
      } catch {
        // Never ACK an event that failed durable storage, especially because
        // Fapshi documents only one webhook attempt per event.
        json(response, 503, { error: "INBOX_UNAVAILABLE" });
      }
      return true;
    }

    const match = PAYMENT_PATH.exec(request.url ?? "");
    if (!match) return false;
    const paymentId = match[1]!;
    const isConfirm = match[2] === "/confirm";
    if (request.method !== (isConfirm ? "POST" : "GET")) {
      json(response, 405, { error: "METHOD_NOT_ALLOWED" });
      return true;
    }
    if (!hasExactlyOneHeader(request, "authorization") ||
        !secretEquals(request.headers.authorization, `Bearer ${options.internalApiToken}`)) {
      json(response, 401, { error: "UNAUTHORIZED" });
      return true;
    }
    try {
      const found = await options.pool.query<{
        payload: {
          provider?: string;
          providerEnvironment?: string;
          providerReference?: string;
          status: string;
          amount: { amountMinor: number; currency: string };
        };
      }>(
        `SELECT payload FROM payment_intents
         WHERE id=$1 AND project_id=$2 AND merchant_id=$3`,
        [paymentId, options.projectId, options.merchantId]
      );
      const payment = found.rows[0]?.payload;
      if (!payment || payment.provider !== "fapshi" ||
          payment.providerEnvironment !== "sandbox" || !payment.providerReference) {
        json(response, 404, { error: "NOT_FOUND" });
        return true;
      }
      if (!isConfirm) {
        json(response, 200, {
          id: paymentId, status: payment.status,
          amountMinor: payment.amount.amountMinor,
          currency: payment.amount.currency
        });
        return true;
      }
      // No POST body is accepted; this endpoint cannot change the expected
      // amount, project, merchant, provider reference or order identity.
      if (request.headers["transfer-encoding"] || Number(request.headers["content-length"] ?? "0") > 0) {
        json(response, 400, { error: "BODY_NOT_ALLOWED" });
        return true;
      }
      if (!await reserve(payment.providerReference)) {
        json(response, 429, { error: "VERIFICATION_BUDGET_EXHAUSTED" });
        return true;
      }
      const result = await options.confirmation.confirm(paymentId);
      json(response, 200, {
        paymentId: result.paymentId,
        confirmed: true,
        replayed: result.replayed
      });
    } catch {
      // No database exception, PSP request, token or PII is echoed to clients.
      json(response, 503, { error: "VERIFICATION_UNAVAILABLE" });
    }
    return true;
  };
}
