import { createHmac } from "node:crypto";
import type { ProviderEnvironment } from "../providers/capabilities.js";
import type { LeasedOutboxDelivery } from "../storage/postgres/durable-messages.js";

export interface SignedPrecisEvent {
  readonly version: 1;
  readonly eventId: string;
  readonly effectKey: string;
  readonly environment: ProviderEnvironment;
  readonly type: "payment.confirmed";
  readonly projectId: string;
  readonly paymentId: string;
  /** Financial evidence only. NO page grants, plans or user identity. */
  readonly data: Readonly<Record<string, unknown>>;
}

export interface PrecisSigningKey {
  readonly keyId: string;
  readonly secret: string;
}

const ID = /^[A-Za-z0-9_:-]{1,160}$/;
const KEY_ID = /^[a-zA-Z0-9_-]{1,40}$/;

export function createPrecisSignedEvent(
  delivery: LeasedOutboxDelivery,
  environment: ProviderEnvironment,
  key: PrecisSigningKey,
  timestampSeconds: number
): { readonly body: string; readonly headers: Readonly<Record<string, string>> } {
  if (delivery.destination !== "precis-payment-events" ||
      !ID.test(delivery.id) || !ID.test(delivery.paymentId) ||
      !ID.test(delivery.projectId) || !ID.test(delivery.effectKey)) {
    throw new Error("Outbox message is not a valid Précis payment event.");
  }
  if (environment !== "sandbox" && environment !== "live") {
    throw new Error("Unsupported payment environment.");
  }
  if (!KEY_ID.test(key.keyId) || key.secret.length < 32 ||
      !Number.isSafeInteger(timestampSeconds) || timestampSeconds < 0) {
    throw new Error("Invalid signature configuration.");
  }
  const payload = delivery.payload;
  if (payload.eventType !== "payment.confirmed" ||
      payload.projectId !== delivery.projectId ||
      payload.paymentId !== delivery.paymentId ||
      payload.provider !== "fapshi" ||
      typeof payload.externalReference !== "string" ||
      !ID.test(payload.externalReference) ||
      typeof payload.providerReference !== "string" ||
      !ID.test(payload.providerReference) ||
      typeof payload.merchantId !== "string" ||
      !ID.test(payload.merchantId) ||
      payload.currency !== "XAF" ||
      !Number.isSafeInteger(payload.amountMinor) ||
      (payload.amountMinor as number) < 100 ||
      (payload.environment !== undefined && payload.environment !== environment) ||
      Object.keys(payload).some(x => ["pages","credits","grant","phone","email","userId"].includes(x))) {
    throw new Error("Untrusted or invalid financial evidence in Précis outbox.");
  }
  const event: SignedPrecisEvent = {
    version: 1, eventId: delivery.id, effectKey: delivery.effectKey,
    environment, type: "payment.confirmed",
    projectId: delivery.projectId, paymentId: delivery.paymentId,
    data: payload
  };
  const body = JSON.stringify(event);
  const digest = createHmac("sha256", key.secret)
    .update(`v1\n${timestampSeconds}\n${delivery.id}\n${body}`)
    .digest("hex");
  return {
    body,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-trigenys-event-id": delivery.id,
      "x-trigenys-key-id": key.keyId,
      "x-trigenys-timestamp": String(timestampSeconds),
      "x-trigenys-signature": `v1=${digest}`
    }
  };
}

/** Deny redirects, credentials, IPs, query strings and non-Trigenys domains. */
export function validatedPrecisEndpoint(endpoint: string): string {
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password ||
      url.port || url.search || url.hash ||
      url.pathname !== "/api/payments/orchestrator/events" ||
      !(/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.trigenys\.com$/).test(url.hostname)) {
    throw new Error("Précis event endpoint must be a fixed Trigenys HTTPS endpoint.");
  }
  return url.toString();
}
