import type { ProviderEnvironment } from "../providers/capabilities.js";
import type {
  LeasedOutboxDelivery, PostgresMessageStore
} from "../storage/postgres/durable-messages.js";
import {
  createPrecisSignedEvent, validatedPrecisEndpoint,
  type PrecisSigningKey
} from "../notifications/precis-signed-event.js";

type OutboxStore = Pick<PostgresMessageStore, "lease" | "acknowledge" | "retryOrQuarantine">;
type PaymentCheck = (delivery: LeasedOutboxDelivery, environment: ProviderEnvironment) => Promise<boolean>;

export interface PrecisOutboxWorkerOptions {
  readonly store: OutboxStore;
  readonly projectId: string;
  readonly environment: ProviderEnvironment;
  readonly endpoint: string;
  readonly signingKey: PrecisSigningKey;
  readonly isVerifiedPayment: PaymentCheck;
  readonly fetchImpl?: typeof fetch;
  readonly nowSeconds?: () => number;
}

export interface PrecisOutboxBatch {
  readonly claimed: number;
  readonly delivered: number;
  readonly retried: number;
  readonly deadLetter: number;
  readonly stale: number;
}

/**
 * Signed at-least-once transport. The receiver's database must deduplicate
 * eventId and its purchase/payment business key; delivery itself cannot
 * guarantee exactly-once external side effects.
 */
export class PrecisOutboxWorker {
  private readonly endpoint: string;
  constructor(private readonly options: PrecisOutboxWorkerOptions) {
    if (!/^[A-Za-z0-9_:/.-]{1,160}$/.test(options.projectId) ||
        !["sandbox", "live"].includes(options.environment)) {
      throw new Error("Missing or invalid financial delivery scope.");
    }
    this.endpoint = validatedPrecisEndpoint(options.endpoint);
    if (options.signingKey.secret.length < 32) {
      throw new Error("Financial notification HMAC key is too short.");
    }
  }

  async runBatch(maximum = 1): Promise<PrecisOutboxBatch> {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 3) {
      throw new Error("Outbox worker batch must be 1–3.");
    }
    const deliveries = await this.options.store.lease(this.options.projectId, maximum, 60);
    const result = { claimed: deliveries.length, delivered: 0, retried: 0, deadLetter: 0, stale: 0 };
    for (const delivery of deliveries) {
      const outcome = await this.deliver(delivery);
      result[outcome]++;
    }
    return result;
  }

  private async failure(
    delivery: LeasedOutboxDelivery, reason: string, permanent = false
  ): Promise<"retried" | "deadLetter" | "stale"> {
    const delay = Math.min(3600, 30 * 2 ** Math.min(Math.max(delivery.attemptCount - 1, 0), 6));
    const status = await this.options.store.retryOrQuarantine(
      delivery.id, delivery.leaseToken, reason, delay, permanent ? 1 : 5
    );
    return status === "retry_scheduled" ? "retried" :
      status === "dead_letter" ? "deadLetter" : "stale";
  }

  private async deliver(delivery: LeasedOutboxDelivery):
    Promise<"delivered" | "retried" | "deadLetter" | "stale"> {
    if (delivery.projectId !== this.options.projectId ||
        delivery.destination !== "precis-payment-events") {
      return this.failure(delivery, "INVALID_DESTINATION", true);
    }

    let verified = false;
    try {
      verified = await this.options.isVerifiedPayment(delivery, this.options.environment);
    } catch {
      return this.failure(delivery, "PAYMENT_CHECK_ERROR");
    }
    if (!verified) return this.failure(delivery, "PAYMENT_UNVERIFIED", true);

    let signed: ReturnType<typeof createPrecisSignedEvent>;
    try {
      signed = createPrecisSignedEvent(
        delivery, this.options.environment, this.options.signingKey,
        (this.options.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))()
      );
    } catch {
      return this.failure(delivery, "INVALID_EVIDENCE", true);
    }

    try {
      const response = await (this.options.fetchImpl ?? fetch)(this.endpoint, {
        method: "POST",
        headers: {
          ...signed.headers,
          "cache-control": "no-store"
        },
        body: signed.body,
        redirect: "error",
        signal: AbortSignal.timeout(8_000)
      });
      // Précis must respond only AFTER committing its durable dedup/inbox
      // transaction. Anything else is uncertain, hence safe to replay.
      const accepted = response.status === 204 &&
        response.headers.get("x-trigenys-event-ack") === delivery.id;
      await response.body?.cancel();
      if (!accepted) return this.failure(delivery, "RECEIVER_NOT_ACKED");
      return await this.options.store.acknowledge(delivery.id, delivery.leaseToken)
        ? "delivered" : "stale";
    } catch {
      return this.failure(delivery, "DELIVERY_IO_ERROR");
    }
  }
}
