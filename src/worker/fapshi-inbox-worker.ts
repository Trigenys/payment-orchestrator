import type { FapshiConfirmation } from "../storage/postgres/fapshi-confirmation.js";
import type { PostgresInboxWorkerStore, InboxLease } from "./inbox-persistence.js";

type InboxStorePort = Pick<PostgresInboxWorkerStore,
  "claim" | "complete" | "retry" | "deferRateLimit" | "findBoundPayment">;
type ConfirmPort = Pick<FapshiConfirmation, "confirm">;

export interface FapshiInboxWorkerOptions {
  readonly projectId: string;
  readonly merchantId: string;
  readonly store: InboxStorePort;
  readonly confirmation: ConfirmPort;
  /** Must use the same PostgreSQL budget as the authenticated REST route. */
  readonly reserveStatusRead: (providerReference: string) => Promise<boolean>;
}

export interface WorkerBatchResult {
  readonly claimed: number;
  readonly processed: number;
  readonly deferred: number;
  readonly retryScheduled: number;
  readonly quarantined: number;
  readonly stale: number;
}

/**
 * Bounded request/schedule-driven worker. No permanent loop or work after an
 * untracked response. Cloud Scheduler or Cloudflare Cron revisits SQL-scheduled
 * retries; extra authenticated sweeps are not the source of truth.
 */
export class FapshiInboxWorker {
  constructor(private readonly options: FapshiInboxWorkerOptions) {
    if (!options.projectId || !options.merchantId) {
      throw new Error("Fapshi inbox worker requires fixed merchant scope.");
    }
  }

  async runBatch(maximum = 3): Promise<WorkerBatchResult> {
    const leases = await this.options.store.claim(maximum);
    const summary = {
      claimed: leases.length, processed: 0, deferred: 0,
      retryScheduled: 0, quarantined: 0, stale: 0
    };

    for (const lease of leases) {
      const disposition = await this.processLease(lease);
      summary[disposition]++;
    }
    return summary;
  }

  private async processLease(lease: InboxLease):
    Promise<"processed" | "deferred" | "retryScheduled" | "quarantined" | "stale"> {
    // Fapshi documents FAILED as potentially attempt-level. Neither FAILED
    // nor EXPIRED webhook evidence may irreversibly change a payment.
    if (lease.status !== "SUCCESSFUL") {
      return (await this.options.store.complete(lease)) ? "processed" : "stale";
    }

    const paymentId = await this.options.store.findBoundPayment(
      lease.providerReference, this.options.projectId, this.options.merchantId
    );
    if (!paymentId) {
      const disposition = await this.options.store.retry(
        lease, "UNBOUND_REFERENCE", 30, 6
      );
      return disposition === "retry_scheduled" ? "retryScheduled" :
        disposition === "quarantined" ? "quarantined" : "stale";
    }

    const permitted = await this.options.reserveStatusRead(lease.providerReference);
    if (!permitted) {
      return (await this.options.store.deferRateLimit(lease, 75)) ?
        "deferred" : "stale";
    }

    try {
      // The coordinator independently reads authenticated PSP status and
      // atomically commits payment, financial ledger and outbox, or nothing.
      await this.options.confirmation.confirm(paymentId);
      return (await this.options.store.complete(lease)) ? "processed" : "stale";
    } catch {
      // Do not leak provider payloads, credentials or PII into error columns.
      // Fapshi is queried *only* after the shared verification reservation.
      const disposition = await this.options.store.retry(
        lease, "CONFIRM_NOT_VERIFIED", Math.min(3600, 30 * 2 ** Math.min(lease.attemptCount - 1, 6)), 6
      );
      return disposition === "retry_scheduled" ? "retryScheduled" :
        disposition === "quarantined" ? "quarantined" : "stale";
    }
  }
}
