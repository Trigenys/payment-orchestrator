import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemorySecretStore,
  ProviderCredentialResolver,
  type ProviderCredentialBinding,
  type SecretMaterial
} from "../src/security/secrets.js";

const activeSecret: SecretMaterial = {
  reference: {
    id: "secret-live-v2",
    environment: "live",
    purpose: "provider_webhook",
    version: 2
  },
  value: "dummy-live-webhook-secret-v2",
  status: "active",
  activatedAt: "2026-10-04T18:00:00.000Z"
};

const retiringSecret: SecretMaterial = {
  reference: {
    id: "secret-live-v1",
    environment: "live",
    purpose: "provider_webhook",
    version: 1
  },
  value: "dummy-live-webhook-secret-v1",
  status: "retiring",
  activatedAt: "2026-09-01T00:00:00.000Z"
};

const revokedSecret: SecretMaterial = {
  reference: {
    id: "secret-live-v0",
    environment: "live",
    purpose: "provider_webhook",
    version: 0
  },
  value: "dummy-live-webhook-secret-v0",
  status: "revoked",
  activatedAt: "2026-08-01T00:00:00.000Z"
};

const binding: ProviderCredentialBinding = {
  provider: "provider-a",
  environment: "live",
  purpose: "provider_webhook",
  secretReferences: [
    activeSecret.reference,
    retiringSecret.reference,
    revokedSecret.reference
  ]
};

test("credential resolver supports rotation overlap but excludes revoked secrets", async () => {
  const resolver = new ProviderCredentialResolver(
    new InMemorySecretStore([
      activeSecret,
      retiringSecret,
      revokedSecret
    ])
  );

  const result = await resolver.resolve(binding, "live");
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.deepEqual(
    result.secrets.map((secret) => secret.reference.id),
    ["secret-live-v2", "secret-live-v1"]
  );
});

test("live provider credentials cannot be resolved in sandbox", async () => {
  const resolver = new ProviderCredentialResolver(
    new InMemorySecretStore([activeSecret])
  );

  const result = await resolver.resolve(binding, "sandbox");
  assert.equal(result.ok, false);
  if (result.ok) return;

  assert.equal(result.error.code, "ENVIRONMENT_MISMATCH");
});

test("credential resolver fails closed when no usable secret remains", async () => {
  const resolver = new ProviderCredentialResolver(
    new InMemorySecretStore([revokedSecret])
  );

  const result = await resolver.resolve({
    ...binding,
    secretReferences: [revokedSecret.reference]
  }, "live");

  assert.equal(result.ok, false);
  if (result.ok) return;

  assert.equal(result.error.code, "NO_ACTIVE_SECRET");
});
