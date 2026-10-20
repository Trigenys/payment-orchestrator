import assert from "node:assert/strict";
import test from "node:test";
import { FapshiHostedClient } from "../src/providers/fapshi/client.js";
import { FapshiHostedConnector } from "../src/providers/fapshi/connector.js";
import { FapshiConfirmation } from "../src/storage/postgres/fapshi-confirmation.js";
import { paymentEnvironment, readInboxRuntimeConfig, runtimeDatabaseUrl, runtimeEnabled, runtimeSecret } from "../src/worker/configuration.js";
import { runOnce } from "../src/worker/run-once.js";
import type { Pool } from "pg";

const both = {
  PAYMENT_SANDBOX_PROJECT_ID: "sandbox-project", PAYMENT_LIVE_PROJECT_ID: "live-project",
  PAYMENT_SANDBOX_MERCHANT_ID: "sandbox-merchant", PAYMENT_LIVE_MERCHANT_ID: "live-merchant",
  FAPSHI_SANDBOX_SERVICE_NAME: "sandbox-service", FAPSHI_LIVE_SERVICE_NAME: "live-service",
  FAPSHI_SANDBOX_APIUSER: "sandbox-user", FAPSHI_LIVE_APIUSER: "live-user",
  FAPSHI_SANDBOX_APIKEY: "sandbox-key", FAPSHI_LIVE_APIKEY: "live-key",
  PAYMENT_SANDBOX_DATABASE_URL: "sandbox-database", PAYMENT_LIVE_DATABASE_URL: "live-database",
  FAPSHI_SANDBOX_WEBHOOK_SECRET: "sandbox-hook", FAPSHI_LIVE_WEBHOOK_SECRET: "live-hook",
  PAYMENT_SANDBOX_INTERNAL_TOKEN: "sandbox-token", PAYMENT_LIVE_INTERNAL_TOKEN: "live-token"
};

test("one environment selects credentials, database, identity and ingress secrets together", () => {
  for (const environment of ["sandbox", "live"] as const) {
    const env = { ...both, PAYMENT_ENVIRONMENT: environment };
    assert.deepEqual(readInboxRuntimeConfig(env), {
      environment, projectId: `${environment}-project`, merchantId: `${environment}-merchant`,
      serviceName: `${environment}-service`, apiuser: `${environment}-user`, apikey: `${environment}-key`
    });
    assert.equal(runtimeDatabaseUrl(env), `${environment}-database`);
    assert.equal(runtimeSecret(env, "WEBHOOK_SECRET"), `${environment}-hook`);
    assert.equal(runtimeSecret(env, "INTERNAL_TOKEN"), `${environment}-token`);
  }
});

test("live never falls back to generic DATABASE_URL, sandbox credentials or old enable flags", async () => {
  const env = { ...both, PAYMENT_ENVIRONMENT: "live", DATABASE_URL: "legacy-sandbox-db" };
  assert.throws(() => runtimeDatabaseUrl({ ...env, PAYMENT_LIVE_DATABASE_URL: undefined }), /PAYMENT_LIVE_DATABASE_URL/);
  assert.throws(() => readInboxRuntimeConfig({ ...env, FAPSHI_LIVE_APIKEY: undefined }), /FAPSHI_LIVE_APIKEY/);
  assert.throws(() => runtimeSecret({ ...env, PAYMENT_LIVE_INTERNAL_TOKEN: undefined }, "INTERNAL_TOKEN"), /PAYMENT_LIVE_INTERNAL_TOKEN/);
  assert.equal(runtimeEnabled({ ...env, PAYMENT_SANDBOX_SWEEP_ENABLED: "true" }, "PAYMENT_SWEEP_ENABLED", "PAYMENT_SANDBOX_SWEEP_ENABLED"), false);
  await assert.rejects(runOnce({ ...env, PAYMENT_SWEEP_ENABLED: "true", FAPSHI_LIVE_APIUSER: "" }), /FAPSHI_LIVE_APIUSER/);
  await assert.rejects(runOnce({ ...env, PAYMENT_SWEEP_ENABLED: "true", PAYMENT_LIVE_DATABASE_URL: "" }), /PAYMENT_LIVE_DATABASE_URL/);
});

test("legacy sandbox configuration stays valid; explicit disable overrides old flags", () => {
  assert.equal(paymentEnvironment({}), "sandbox");
  assert.equal(runtimeDatabaseUrl({ DATABASE_URL: "legacy" }), "legacy");
  assert.equal(runtimeEnabled({ PAYMENT_SANDBOX_SWEEP_ENABLED: "true" }, "PAYMENT_SWEEP_ENABLED", "PAYMENT_SANDBOX_SWEEP_ENABLED"), true);
  assert.equal(runtimeEnabled({ PAYMENT_SWEEP_ENABLED: "false", PAYMENT_SANDBOX_SWEEP_ENABLED: "true" }, "PAYMENT_SWEEP_ENABLED", "PAYMENT_SANDBOX_SWEEP_ENABLED"), false);
});

test("unknown environments and mismatched confirmation/connector fail before database or HTTP", () => {
  for (const value of ["production", "LIVE", "", "https://other.example"]) {
    assert.throws(() => paymentEnvironment({ PAYMENT_ENVIRONMENT: value }), /environment must be/);
    assert.throws(() => new FapshiHostedClient({
      ...{ environment: value } as { environment: "live" },
      httpClient: { request: async () => { throw new Error("Unexpected HTTP"); } },
      getCredentials: async () => { throw new Error("Unexpected secret resolution"); }
    }), /environment must be/);
  }
  const connector = new FapshiHostedConnector({
    client: new FapshiHostedClient({
      httpClient: { request: async () => { throw new Error("Unexpected HTTP"); } },
      getCredentials: async () => ({ apiuser: "sandbox", apikey: "sandbox" })
    }), projectId: "p", merchantId: "m"
  });
  assert.throws(() => new FapshiConfirmation({
    environment: "live", pool: {} as Pool, connector, projectId: "p", merchantId: "m", expectedServiceName: "service"
  }), /matching environment/);
});
