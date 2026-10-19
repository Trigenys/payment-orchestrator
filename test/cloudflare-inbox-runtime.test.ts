import assert from "node:assert/strict";
import test from "node:test";
import worker, { handleInboxRequest, runScheduledInbox, type InvocationFactory } from "../src/cloudflare/inbox-runtime.js";

const token = "sandbox-internal-secret-at-least-32-characters";
const base = "https://example.workers.dev";
function fixture() {
  const env: PaymentInboxEnv = {
    HYPERDRIVE: {
      connectionString: "not-used", host: "not-used", ip: "127.0.0.1", port: 5432,
      user: "not-used", password: "not-used", database: "not-used",
      connect: () => { throw new Error("No socket in unit tests"); }
    },
    CLOUDFLARE_SANDBOX_INBOX_ENABLED: "true",
    PAYMENT_SANDBOX_PROJECT_ID: "project-1",
    PAYMENT_SANDBOX_MERCHANT_ID: "merchant-1",
    FAPSHI_SANDBOX_SERVICE_NAME: "sandbox-service",
    FAPSHI_SANDBOX_APIUSER: "test-user",
    FAPSHI_SANDBOX_APIKEY: "test-key",
    PAYMENT_SANDBOX_INTERNAL_TOKEN: token
  };
  const calls = { opened: 0, ready: 0, batches: [] as number[], closed: 0 };
  let schemaReady = true;
  let fail = false;
  const summary = { claimed: 1, processed: 1, deferred: 0, retryScheduled: 0, quarantined: 0, stale: 0 };
  const factory: InvocationFactory = (_env, config) => {
    calls.opened++;
    assert.equal(config.projectId, "project-1");
    return {
      ready: async () => { calls.ready++; return schemaReady; },
      runBatch: async maximum => {
        calls.batches.push(maximum);
        if (fail) throw new Error("secret-provider-payload");
        return summary;
      },
      close: async () => { calls.closed++; }
    };
  };
  const request = (path = "/internal/fapshi-inbox/drain", init: RequestInit = {}) =>
    new Request(base + path, { method: "POST", headers: { authorization: `Bearer ${token}` }, ...init });
  return { env, calls, factory, request, summary,
    missingSchema: () => { schemaReady = false; }, fail: () => { fail = true; } };
}

test("Cloudflare dispatch authenticates before opening PostgreSQL", async () => {
  const f = fixture();
  const attempts: Record<string, string>[] = [{}, { authorization: "Bearer wrong" }, { authorization: `Bearer ${token}, Bearer ${token}` }];
  for (const headers of attempts) {
    const result = await handleInboxRequest(f.request(undefined, { headers }), f.env, f.factory);
    assert.equal(result.status, 401);
  }
  assert.equal(f.calls.opened, 0);
});

test("one bounded batch per invocation, pool closed and not reused", async () => {
  const f = fixture();
  for (let i = 0; i < 2; i++) {
    const result = await handleInboxRequest(f.request(), f.env, f.factory);
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), f.summary);
  }
  assert.deepEqual(f.calls, { opened: 2, ready: 2, batches: [1, 1], closed: 2 });
});

test("Cloudflare-style empty POST stream is accepted but streamed data is rejected", async () => {
  const f = fixture();
  const make = (data?: string) => new Request(base + "/internal/fapshi-inbox/drain", {
    method: "POST", headers: { authorization: `Bearer ${token}` },
    body: new ReadableStream({ start(controller) {
      if (data) controller.enqueue(new TextEncoder().encode(data));
      controller.close();
    } }), duplex: "half"
  } as RequestInit);
  assert.equal((await handleInboxRequest(make(), f.env, f.factory)).status, 200);
  assert.equal((await handleInboxRequest(make("{}"), f.env, f.factory)).status, 400);
  assert.equal(f.calls.opened, 1);
});

test("disabled or incomplete configuration never opens a database", async () => {
  for (const patch of [
    { CLOUDFLARE_SANDBOX_INBOX_ENABLED: "false" },
    { FAPSHI_SANDBOX_APIKEY: "" }, { FAPSHI_SANDBOX_APIUSER: "" },
    { PAYMENT_SANDBOX_PROJECT_ID: "" }, { FAPSHI_SANDBOX_SERVICE_NAME: "" }
  ]) {
    const f = fixture(); Object.assign(f.env, patch);
    assert.equal((await handleInboxRequest(f.request(), f.env, f.factory)).status, 503);
    if (f.env.CLOUDFLARE_SANDBOX_INBOX_ENABLED !== "true") {
      assert.equal(await runScheduledInbox(f.env, f.factory), undefined);
    } else {
      await assert.rejects(runScheduledInbox(f.env, f.factory), /SANDBOX_INBOX_NOT_CONFIGURED/);
    }
    assert.equal(f.calls.opened, 0);
  }
});

test("missing schema and processing failure close the pool and sanitize errors", async () => {
  const missing = fixture(); missing.missingSchema();
  assert.equal((await handleInboxRequest(missing.request(), missing.env, missing.factory)).status, 503);
  assert.equal(missing.calls.batches.length, 0);
  assert.equal(missing.calls.closed, 1);
  const broken = fixture(); broken.fail();
  const response = await handleInboxRequest(broken.request(), broken.env, broken.factory);
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes("secret-provider-payload"), false);
  assert.equal(broken.calls.closed, 1);
});

test("scheduled invocations await the batch, close the pool, and fail visibly", async () => {
  const f = fixture();
  assert.deepEqual(await runScheduledInbox(f.env, f.factory), f.summary);
  assert.deepEqual(f.calls.batches, [1]);
  assert.equal(f.calls.closed, 1);
  f.fail();
  await assert.rejects(runScheduledInbox(f.env, f.factory), /SANDBOX_INBOX_SWEEP_FAILED/);
  assert.equal(f.calls.closed, 2);
});

test("requests cannot supply a body, query, live route or batch size", async () => {
  const f = fixture();
  for (const request of [f.request("/internal/fapshi-inbox/drain?batchSize=10"), f.request(undefined, { body: "{}" })]) {
    assert.equal((await handleInboxRequest(request, f.env, f.factory)).status, 400);
  }
  assert.equal((await handleInboxRequest(f.request("/v1/payments"), f.env, f.factory)).status, 404);
  assert.equal((await handleInboxRequest(f.request(undefined, { method: "GET" }), f.env, f.factory)).status, 405);
  assert.equal(f.calls.opened, 0);
});

test("liveness is database-free; readiness requires internal authentication", async () => {
  const f = fixture();
  const response = await worker.fetch(new Request(base + "/health"), f.env);
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { livePaymentsEnabled: boolean }).livePaymentsEnabled, false);
  assert.equal((await handleInboxRequest(new Request(base + "/ready"), f.env, f.factory)).status, 401);
  const ready = await handleInboxRequest(f.request("/ready", { method: "GET" }), f.env, f.factory);
  assert.equal(ready.status, 200);
  assert.equal(f.calls.closed, 1);
  assert.equal(f.calls.batches.length, 0);
});
