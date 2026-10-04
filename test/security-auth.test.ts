import assert from "node:assert/strict";
import test from "node:test";
import {
  InMemoryProjectCredentialStore,
  ProjectApiKeyAuthenticator,
  authorizeProject,
  projectApiSecretDigest
} from "../src/security/auth.js";

const pepper = "dummy-test-pepper";
const secret = "0123456789abcdef0123456789";
const apiKey = `po_test_cred-1.${secret}`;

const store = new InMemoryProjectCredentialStore([
  {
    credentialId: "cred-1",
    projectId: "project-zamari",
    environment: "sandbox",
    secretDigest: projectApiSecretDigest(secret, pepper),
    scopes: ["payments:create", "payments:read"],
    createdAt: "2026-10-04T18:00:00.000Z"
  },
  {
    credentialId: "cred-revoked",
    projectId: "project-zamari",
    environment: "sandbox",
    secretDigest: projectApiSecretDigest(secret, pepper),
    scopes: ["payments:read"],
    createdAt: "2026-10-04T18:00:00.000Z",
    revokedAt: "2026-10-04T18:30:00.000Z"
  }
]);

test("project API key authentication returns a least-privilege principal", async () => {
  const auth = new ProjectApiKeyAuthenticator(store, pepper);
  const result = await auth.authenticate(apiKey);

  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.principal.projectId, "project-zamari");
  assert.equal(result.principal.environment, "sandbox");
  assert.deepEqual(result.principal.scopes, ["payments:create", "payments:read"]);
});

test("invalid API key material fails closed", async () => {
  const auth = new ProjectApiKeyAuthenticator(store, pepper);
  const result = await auth.authenticate(
    "po_test_cred-1.ffffffffffffffffffffffff"
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "INVALID_API_KEY");
});

test("revoked project credentials cannot authenticate", async () => {
  const auth = new ProjectApiKeyAuthenticator(store, pepper);
  const result = await auth.authenticate(
    `po_test_cred-revoked.${secret}`
  );

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "CREDENTIAL_REVOKED");
});

test("authorization rejects tenant crossover", () => {
  const result = authorizeProject({
    credentialId: "cred-1",
    projectId: "project-zamari",
    environment: "sandbox",
    scopes: ["payments:create"]
  }, {
    projectId: "project-other",
    environment: "sandbox",
    requiredScopes: ["payments:create"]
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "PROJECT_MISMATCH");
});

test("authorization rejects environment crossover", () => {
  const result = authorizeProject({
    credentialId: "cred-1",
    projectId: "project-zamari",
    environment: "sandbox",
    scopes: ["payments:create"]
  }, {
    projectId: "project-zamari",
    environment: "live",
    requiredScopes: ["payments:create"]
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "ENVIRONMENT_MISMATCH");
});

test("authorization requires explicit scopes", () => {
  const result = authorizeProject({
    credentialId: "cred-1",
    projectId: "project-zamari",
    environment: "sandbox",
    scopes: ["payments:read"]
  }, {
    projectId: "project-zamari",
    environment: "sandbox",
    requiredScopes: ["payments:create"]
  });

  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "SCOPE_MISSING");
});
