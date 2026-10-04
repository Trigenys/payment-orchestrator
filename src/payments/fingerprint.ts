import { createHash } from "node:crypto";
import type { CreatePaymentCommand, NormalizedProviderPaymentEvent } from "./types.js";

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(",")}]`;
  }

  const record = value as Readonly<Record<string, unknown>>;
  const entries = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`);

  return `{${entries.join(",")}}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

export function paymentCreationFingerprint(command: CreatePaymentCommand): string {
  const allocations = command.allocations
    ? [...command.allocations].sort((left, right) => {
        const providerCompare = left.providerAccountId.localeCompare(right.providerAccountId);
        if (providerCompare !== 0) return providerCompare;
        if (left.amount.currency !== right.amount.currency) {
          return left.amount.currency.localeCompare(right.amount.currency);
        }
        return left.amount.amountMinor - right.amount.amountMinor;
      })
    : undefined;

  return digest({
    projectId: command.projectId,
    merchantId: command.merchantId,
    providerAccountId: command.providerAccountId,
    externalReference: command.externalReference,
    amount: command.amount,
    channel: command.channel,
    allocations
  });
}

export function providerEventFingerprint(event: NormalizedProviderPaymentEvent): string {
  return digest({
    provider: event.provider.trim().toLowerCase(),
    environment: event.environment,
    eventId: event.eventId,
    providerPaymentReference: event.providerPaymentReference,
    status: event.status,
    occurredAt: event.occurredAt,
    payloadDigest: event.payloadDigest
  });
}
