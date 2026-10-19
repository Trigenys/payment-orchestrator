import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

export interface ServiceInfo {
  name: string;
  version: string;
}

export type ServiceRouteHandler = (
  request: IncomingMessage,
  response: ServerResponse
) => Promise<boolean> | boolean;

/**
 * The existing /health stays independent of PostgreSQL and payment providers.
 * Opt-in sandbox routes are mounted only by the explicitly configured runtime.
 */
export function createServiceServer(
  info: ServiceInfo,
  routes?: ServiceRouteHandler
) {
  return createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
        response.end(JSON.stringify({
          status: "ok",
          service: info.name,
          version: info.version
        }));
        return;
      }

      if (routes && await routes(request, response)) return;

      response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({ error: "NOT_FOUND" }));
    })().catch(() => {
      // Never serialize route/database exceptions into HTTP responses.
      if (!response.headersSent) {
        response.writeHead(503, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        response.end(JSON.stringify({ error: "SERVICE_UNAVAILABLE" }));
      } else if (!response.writableEnded) {
        response.end();
      }
    });
  });
}
