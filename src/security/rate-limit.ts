export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterMs: number;
}

export interface RateLimiter {
  consume(key: string, nowMs?: number): RateLimitDecision;
}

interface WindowState {
  startedAt: number;
  count: number;
}

export class InMemoryFixedWindowRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, WindowState>();

  constructor(
    private readonly maxRequests: number,
    private readonly windowMs: number
  ) {
    if (!Number.isInteger(maxRequests) || maxRequests <= 0) {
      throw new TypeError("maxRequests must be a positive integer.");
    }

    if (!Number.isFinite(windowMs) || windowMs <= 0) {
      throw new TypeError("windowMs must be greater than zero.");
    }
  }

  consume(key: string, nowMs = Date.now()): RateLimitDecision {
    const normalizedKey = key.trim();
    if (!normalizedKey) {
      throw new TypeError("Rate limit key must not be empty.");
    }

    const existing = this.windows.get(normalizedKey);

    if (!existing || nowMs - existing.startedAt >= this.windowMs) {
      this.windows.set(normalizedKey, {
        startedAt: nowMs,
        count: 1
      });

      return {
        allowed: true,
        remaining: this.maxRequests - 1,
        retryAfterMs: 0
      };
    }

    if (existing.count >= this.maxRequests) {
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(
          1,
          this.windowMs - (nowMs - existing.startedAt)
        )
      };
    }

    existing.count += 1;

    return {
      allowed: true,
      remaining: this.maxRequests - existing.count,
      retryAfterMs: 0
    };
  }
}
