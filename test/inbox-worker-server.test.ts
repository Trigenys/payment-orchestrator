import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createInboxWorkerServer } from "../src/worker/server.js";

test("Cloud Run worker exposes only liveness, readiness and request-driven drain", async t => {
  let invokes = 0;
  const server = createInboxWorkerServer({
    batchSize: 2,
    ready: async () => true,
    worker: {
      runBatch: async max => {
        invokes++;
        assert.equal(max, 2);
        return {
          claimed: 1, processed: 1, deferred: 0,
          retryScheduled: 0, quarantined: 0, stale: 0
        };
      }
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}`;

  assert.equal((await fetch(base + "/health")).status, 200);
  assert.equal((await fetch(base + "/ready")).status, 200);
  assert.equal((await fetch(base + "/internal/fapshi-inbox/drain")).status, 405);
  assert.equal((await fetch(base + "/v1/webhooks/fapshi/sandbox", { method: "POST" })).status, 404);
  assert.equal((await fetch(base + "/internal/fapshi-inbox/drain", {
    method: "POST", headers: { "content-type": "application/json" }, body: "{}"
  })).status, 400);
  assert.equal(invokes, 0);

  const response = await fetch(base + "/internal/fapshi-inbox/drain", { method: "POST" });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { processed: number }).processed, 1);
  assert.equal(invokes, 1);
});

test("worker readiness and failures are reported without exposing infrastructure data", async t => {
  const server = createInboxWorkerServer({
    ready: async () => false,
    worker: {
      runBatch: async () => { throw new Error("postgres_password=REDACT"); }
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const addr = server.address();
  assert.ok(addr && typeof addr === "object");
  const base = `http://127.0.0.1:${addr.port}`;

  assert.equal((await fetch(base + "/ready")).status, 503);
  const response = await fetch(base + "/internal/fapshi-inbox/drain", { method: "POST" });
  assert.equal(response.status, 503);
  const text = await response.text();
  assert.ok(!text.includes("postgres_password"));
  assert.ok(text.includes("WORKER_UNAVAILABLE"));
});
