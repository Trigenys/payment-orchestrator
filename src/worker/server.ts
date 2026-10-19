import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { FapshiInboxWorker, WorkerBatchResult } from "./fapshi-inbox-worker.js";

export interface WorkerServerOptions {
  readonly worker: Pick<FapshiInboxWorker, "runBatch">;
  readonly ready: () => Promise<boolean>;
  readonly batchSize?: number;
}

function reply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(JSON.stringify(value));
}

/**
 * Dedicated private Cloud Run service, never mounted on the public callback
 * API. Authentication MUST be enforced by Cloud Run IAM (roles/run.invoker +
 * Google-signed OIDC on Cloud Scheduler/Cloud Tasks calls).
 *
 * Trust no unverified request header as an identity assertion. Do not deploy
 * with --allow-unauthenticated.
 */
export function createInboxWorkerServer(options: WorkerServerOptions) {
  if (!Number.isSafeInteger(options.batchSize ?? 3) ||
      (options.batchSize ?? 3) < 1 || (options.batchSize ?? 3) > 3) {
    throw new Error("Cloud Run worker batch size must be 1–3.");
  }
  const batchSize = options.batchSize ?? 3;
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.url === "/health" && req.method === "GET") {
        reply(res, 200, { status: "ok" });
        return;
      }
      if (req.url === "/ready" && req.method === "GET") {
        const isReady = await options.ready();
        reply(res, isReady ? 200 : 503, { status: isReady ? "ready" : "unavailable" });
        return;
      }
      if (req.url === "/internal/fapshi-inbox/drain") {
        if (req.method !== "POST") {
          reply(res, 405, { error: "METHOD_NOT_ALLOWED" });
          return;
        }
        if (req.headers["transfer-encoding"] ||
            Number(req.headers["content-length"] ?? "0") > 0) {
          reply(res, 400, { error: "BODY_NOT_ALLOWED" });
          return;
        }
        const summary: WorkerBatchResult = await options.worker.runBatch(batchSize);
        reply(res, 200, summary);
        return;
      }
      reply(res, 404, { error: "NOT_FOUND" });
    })().catch(() => {
      if (!res.headersSent) {
        reply(res, 503, { error: "WORKER_UNAVAILABLE" });
      } else if (!res.writableEnded) {
        res.end();
      }
    });
  });
}
