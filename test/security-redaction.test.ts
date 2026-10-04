import assert from "node:assert/strict";
import test from "node:test";
import { REDACTED, redactSensitive } from "../src/security/redaction.js";

test("structured redaction removes sensitive fields recursively", () => {
  const redacted = redactSensitive({
    authorization: "Bearer abcdefghijklmnop",
    api_key: "secret-value",
    nested: {
      password: "pass",
      safe: "visible"
    },
    raw_body: new Uint8Array([1, 2, 3])
  }) as Record<string, unknown>;

  assert.equal(redacted.authorization, REDACTED);
  assert.equal(redacted.api_key, REDACTED);
  assert.deepEqual(redacted.nested, {
    password: REDACTED,
    safe: "visible"
  });
  assert.equal(redacted.raw_body, REDACTED);
});

test("API-key-like values are redacted even under a non-sensitive key", () => {
  const redacted = redactSensitive({
    message: "key=po_test_cred-1.0123456789abcdef0123456789"
  }) as { message: string };

  assert.doesNotMatch(redacted.message, /0123456789abcdef/);
  assert.match(redacted.message, /REDACTED/);
});
