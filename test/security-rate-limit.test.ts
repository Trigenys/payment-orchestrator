import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryFixedWindowRateLimiter } from "../src/security/rate-limit.js";

test("rate limiter blocks requests above the configured window", () => {
  const limiter = new InMemoryFixedWindowRateLimiter(2, 1_000);

  assert.equal(limiter.consume("provider-a:sandbox:1.2.3.4", 0).allowed, true);
  assert.equal(limiter.consume("provider-a:sandbox:1.2.3.4", 100).allowed, true);

  const blocked = limiter.consume("provider-a:sandbox:1.2.3.4", 200);
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.remaining, 0);
  assert.equal(blocked.retryAfterMs, 800);
});

test("rate limiter resets after the window", () => {
  const limiter = new InMemoryFixedWindowRateLimiter(1, 1_000);

  assert.equal(limiter.consume("key", 0).allowed, true);
  assert.equal(limiter.consume("key", 500).allowed, false);
  assert.equal(limiter.consume("key", 1_000).allowed, true);
});
