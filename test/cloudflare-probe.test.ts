import assert from "node:assert/strict";
import test from "node:test";
import { handleCloudflareProbe } from "../src/cloudflare/probe.js";

test("Cloudflare diagnostic never exposes payments or an active backend", async () => {
  const url = "https://example.workers.dev";
  const ok = handleCloudflareProbe(new Request(url + "/health"));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("cache-control"), "no-store");
  const parsed = await ok.json() as { paymentsEnabled: boolean; databaseConnected: boolean };
  assert.equal(parsed.paymentsEnabled, false);
  assert.equal(parsed.databaseConnected, false);
});

test("Cloudflare readiness is intentionally 503 and money routes are 404", async () => {
  const url = "https://example.workers.dev";
  const ready = handleCloudflareProbe(new Request(url + "/ready"));
  assert.equal(ready.status, 503);
  assert.equal((await ready.json() as { paymentsEnabled: boolean }).paymentsEnabled, false);
  const confirm = handleCloudflareProbe(new Request(url + "/v1/sandbox/payments/any/confirm", { method: "POST" }));
  assert.equal(confirm.status, 404);
  const webhook = handleCloudflareProbe(new Request(url + "/v1/webhooks/fapshi/sandbox", { method: "POST" }));
  assert.equal(webhook.status, 404);
});
