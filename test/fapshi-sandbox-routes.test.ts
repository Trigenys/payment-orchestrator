import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import type { Pool } from "pg";
import { createFapshiSandboxRoutes } from "../src/api/fapshi-sandbox-routes.js";
import { createServiceServer } from "../src/server.js";
import type { InboxInput } from "../src/storage/postgres/durable-messages.js";

const token = "t".repeat(48);
const webhookSecret = "w".repeat(48);

function fixture() {
  const receipts: InboxInput[] = [];
  const confirmations: string[] = [];
  const verificationRequests: string[] = [];
  let allowed = true;
  const routes = createFapshiSandboxRoutes({
    pool: {
      query: async () => ({
        rows: [{
          payload: {
            provider: "fapshi", providerEnvironment: "sandbox",
            providerReference: "trans-1", status: "created",
            amount: { amountMinor: 150, currency: "XAF" }
          }
        }]
      })
    } as unknown as Pool,
    projectId: "project-precis",
    merchantId: "merchant-precis",
    expectedServiceName: "Precís test service",
    webhookSecret,
    internalApiToken: token,
    messageStore: {
      recordInbox: async receipt => {
        receipts.push(receipt);
        return { id: "inbox-id", replayed: receipts.length > 1, status: "received" };
      }
    },
    confirmation: {
      confirm: async paymentId => {
        confirmations.push(paymentId);
        return { paymentId, ledgerBatchId: "ledger", outboxId: "outbox", replayed: false };
      }
    },
    reserveStatusRead: async ref => {
      verificationRequests.push(ref);
      return allowed;
    }
  });
  const server = createServiceServer({ name: "test", version: "0.1.0" }, routes);
  return {
    receipts, confirmations, verificationRequests,
    server, disallow: () => { allowed = false; }
  };
}

function payload(extra: Readonly<Record<string, unknown>> = {}) {
  return {
    transId: "trans-1", status: "SUCCESSFUL",
    transType: "Collection", serviceName: "Precís test service",
    amount: 150, revenue: 140, externalId: "order-1",
    payerName: "sensitive customer name", email: "private@example.test",
    ...extra
  };
}

test("sandbox webhook enforces secret, JSON bounds and privacy", async t => {
  const app = fixture();
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => app.server.close());
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const route = base + "/v1/webhooks/fapshi/sandbox";

  const unauthenticated = await fetch(route, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(payload())
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(app.receipts.length, 0);

  const wrongSecret = await fetch(route, {
    method: "POST", headers: {
      "content-type": "application/json", "x-wh-secret": "wrong"
    },
    body: JSON.stringify(payload())
  });
  assert.equal(wrongSecret.status, 401);

  const headers = {
    "content-type": "application/json",
    "x-wh-secret": webhookSecret
  };
  const accepted = await fetch(route, {
    method: "POST", headers, body: JSON.stringify(payload())
  });
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { status: "received", replayed: false });
  assert.equal(app.receipts.length, 1);
  assert.deepEqual(app.receipts[0]?.payload, {
    transId: "trans-1", status: "SUCCESSFUL", transType: "Collection",
    serviceName: "Precís test service", amount: 150,
    revenue: 140, externalId: "order-1"
  });

  const replay = await fetch(route, {
    method: "POST", headers, body: JSON.stringify(payload())
  });
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), { status: "received", replayed: true });

  const badService = await fetch(route, {
    method: "POST", headers,
    body: JSON.stringify(payload({ serviceName: "Another service" }))
  });
  assert.equal(badService.status, 422);
  const payout = await fetch(route, {
    method: "POST", headers,
    body: JSON.stringify(payload({ transType: "Payout" }))
  });
  assert.equal(payout.status, 422);
  const malformed = await fetch(route, {
    method: "POST", headers, body: "not-json"
  });
  assert.equal(malformed.status, 400);
  const huge = await fetch(route, {
    method: "POST", headers, body: JSON.stringify(payload({ junk: "x".repeat(12000) }))
  });
  assert.equal(huge.status, 413);
  assert.equal(app.receipts.length, 2);
  assert.equal((await fetch(base + "/health")).status, 200);
});

test("internal routes require separate bearer secret, persisted status and quota", async t => {
  const app = fixture();
  app.server.listen(0, "127.0.0.1");
  await once(app.server, "listening");
  t.after(() => app.server.close());
  const address = app.server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const paymentUrl = base + "/v1/sandbox/payments/pay-1";

  assert.equal((await fetch(paymentUrl)).status, 401);
  const authorized = { authorization: `Bearer ${token}` };
  const queried = await fetch(paymentUrl, { headers: authorized });
  assert.equal(queried.status, 200);
  assert.deepEqual(await queried.json(), {
    id: "pay-1", status: "created", amountMinor: 150, currency: "XAF"
  });
  assert.equal((await fetch(paymentUrl + "/confirm", {
    method: "POST", headers: { authorization: `Bearer ${webhookSecret}` }
  })).status, 401);
  const confirmed = await fetch(paymentUrl + "/confirm", {
    method: "POST", headers: authorized
  });
  assert.equal(confirmed.status, 200);
  assert.deepEqual(await confirmed.json(), {
    paymentId: "pay-1", confirmed: true, replayed: false
  });
  assert.deepEqual(app.confirmations, ["pay-1"]);
  assert.deepEqual(app.verificationRequests, ["trans-1"]);

  app.disallow();
  assert.equal((await fetch(paymentUrl + "/confirm", {
    method: "POST", headers: authorized
  })).status, 429);
  assert.equal(app.confirmations.length, 1);
  assert.equal((await fetch(paymentUrl + "/confirm", {
    method: "POST", headers: {
      ...authorized, "content-type": "application/json"
    }, body: "{}"
  })).status, 400);
  assert.equal((await fetch(base + "/v1/sandbox/payments/does-not-match?debug=1", {
    headers: authorized
  })).status, 404);
});

test("default server exposes no sandbox routes", async t => {
  const server = createServiceServer({ name: "test", version: "0.1.0" });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const r = await fetch(`http://127.0.0.1:${address.port}/v1/webhooks/fapshi/sandbox`, {
    method: "POST"
  });
  assert.equal(r.status, 404);
});
