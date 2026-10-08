import { randomUUID } from "node:crypto";

export type IdempotencyKey = string;

export function createIdempotencyKey(prefix = "idem"): IdempotencyKey {
  const normalized = prefix.trim().replace(/[^A-Za-z0-9_-]+/g, "-");
  return `${normalized || "idem"}_${randomUUID()}`;
}
