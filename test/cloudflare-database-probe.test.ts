import assert from "node:assert/strict";
import test from "node:test";
import { handleCloudflareDatabaseProbe } from "../src/cloudflare/database-probe.js";

const env = { HYPERDRIVE: { connectionString: "not-used-in-handler-tests" } } as PaymentProbeEnv;
const url = "https://example.workers.dev";

test("a connected database never makes the financial runtime ready", async () => {
  const response = await handleCloudflareDatabaseProbe(new Request(url + "/ready"), env, async () => true);
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), {
    status: "not_ready", reason: "sandbox_payment_runtime_not_enabled",
    sandbox: true, databaseConnected: true, paymentsEnabled: false
  });
});

test("database errors are sanitized and missing migrations fail closed", async () => {
  for (const check of [async () => false, async () => { throw new Error("secret-password"); }]) {
    const response = await handleCloudflareDatabaseProbe(new Request(url + "/ready"), env, check);
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.equal(text.includes("secret-password"), false);
    assert.equal(JSON.parse(text).databaseConnected, false);
    assert.equal(JSON.parse(text).paymentsEnabled, false);
  }
});

test("health and unknown money routes never access PostgreSQL", async () => {
  const unexpected = async () => { assert.fail("database should not be called"); };
  for (const [path, method, expected] of [
    ["/health", "GET", 200], ["/ready", "POST", 404],
    ["/v1/payments", "POST", 404], ["/v1/webhooks/fapshi/sandbox", "POST", 404]
  ] as const) {
    const response = await handleCloudflareDatabaseProbe(new Request(url + path, { method }), env, unexpected);
    assert.equal(response.status, expected);
  }
});
