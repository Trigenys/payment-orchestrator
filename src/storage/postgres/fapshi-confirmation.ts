import type { Pool, PoolClient } from "pg";
import type { Payment } from "../../domain/models.js";
import { LedgerService } from "../../ledger/service.js";
import type { LedgerPersistence } from "../../ledger/persistence.js";
import { PaymentService } from "../../payments/service.js";
import type { PaymentPersistence } from "../../payments/persistence.js";
import type { PaymentVerification } from "../../providers/contracts.js";
import { FapshiHostedConnector } from "../../providers/fapshi/connector.js";
import { PostgresLedgerTransaction } from "./ledger-persistence.js";
import { PostgresPaymentTransaction } from "./payment-persistence.js";
import { enqueueOutboxInTransaction } from "./durable-messages.js";

export interface FapshiConfirmationOptions {
  readonly pool: Pool;
  /** Pilot service identity; NOT user-controlled fields from an HTTP request. */
  readonly projectId: string;
  readonly merchantId: string;
  readonly providerAccountId?: string;
  readonly expectedServiceName: string;
  readonly connector: FapshiHostedConnector;
}

export interface FapshiConfirmationOutcome {
  readonly paymentId: string;
  readonly ledgerBatchId: string;
  readonly outboxId: string;
  readonly replayed: boolean;
}

/**
 * Sandbox-only transaction coordinator.
 *
 * The provider is queried by the authenticated Fapshi connector BEFORE
 * obtaining a DB transaction/lock. Everything afterwards uses one PoolClient:
 * payment state transition + financial journal + outgoing notification.
 *
 * This is NOT a route handler, callback handler, public API or entitlement
 * grant. A future authenticated worker must throttle verification attempts
 * to Fapshi's documented per-transaction status-query rate.
 */
export class FapshiSandboxConfirmation {
  constructor(private readonly options: FapshiConfirmationOptions) {
    if (!options.projectId || !options.merchantId ||
        !options.expectedServiceName.trim() ||
        options.connector.provider !== "fapshi") {
      throw new Error("Fapshi sandbox confirmation requires explicit service identity.");
    }
  }

  private ensureIdentity(payment: Payment): void {
    if (payment.projectId !== this.options.projectId ||
        payment.merchantId !== this.options.merchantId ||
        payment.providerAccountId !== this.options.providerAccountId ||
        payment.provider !== "fapshi" ||
        payment.providerEnvironment !== "sandbox" ||
        !payment.providerReference ||
        payment.amount.currency !== "XAF" ||
        !Number.isSafeInteger(payment.amount.amountMinor) ||
        payment.amount.amountMinor < 100) {
      throw new Error("Payment is not a bound Fapshi sandbox collection for this service.");
    }
  }

  private validateVerification(payment: Payment, verified: PaymentVerification): {
    readonly feeMinor: number;
    readonly revenueMinor: number;
  } {
    const metadata = verified.providerMetadata;
    const revenueMinor = metadata?.revenueMinor;
    const feeMinor = metadata?.feeMinor;
    if (verified.status !== "succeeded" ||
        metadata?.providerStatus !== "SUCCESSFUL" ||
        metadata?.serviceName !== this.options.expectedServiceName ||
        verified.providerReference !== payment.providerReference ||
        verified.externalReference !== payment.externalReference ||
        verified.amount.currency !== "XAF" ||
        verified.amount.amountMinor !== payment.amount.amountMinor ||
        !Number.isSafeInteger(revenueMinor) ||
        !Number.isSafeInteger(feeMinor) ||
        (revenueMinor as number) <= 0 ||
        (feeMinor as number) < 0 ||
        (revenueMinor as number) + (feeMinor as number) !== payment.amount.amountMinor) {
      throw new Error("Authoritative Fapshi result does not match the stored payment and fees.");
    }
    if (Number.isNaN(Date.parse(verified.verifiedAt))) {
      throw new Error("Authoritative Fapshi verification timestamp is invalid.");
    }
    return { revenueMinor: revenueMinor as number, feeMinor: feeMinor as number };
  }

  async confirm(paymentId: string): Promise<FapshiConfirmationOutcome> {
    if (!/^[A-Za-z0-9_:-]{1,160}$/.test(paymentId)) {
      throw new Error("Invalid payment identifier.");
    }

    // Scoped discovery avoids leaking other project payment details.
    const initial = await this.options.pool.query<{ payload: Payment }>(
      `SELECT payload FROM payment_intents
       WHERE id=$1 AND project_id=$2 AND merchant_id=$3`,
      [paymentId, this.options.projectId, this.options.merchantId]
    );
    const preliminary = initial.rows[0]?.payload;
    if (!preliminary) throw new Error("Payment not found in the configured service.");
    this.ensureIdentity(preliminary);

    // Do NOT trust browser redirects or webhook callback content. The PSP's
    // authenticated status endpoint is the sole status authority here.
    const response = await this.options.connector.verifyPayment(
      { externalReference: preliminary.providerReference! },
      { projectId: this.options.projectId, environment: "sandbox", country: "CM", currency: "XAF" }
    );
    if (!response.ok) {
      throw new Error(`Fapshi status verification failed: ${response.error.code}`);
    }
    const authoritative = response.value;
    this.validateVerification(preliminary, authoritative);

    const client = await this.options.pool.connect();
    let begun = false;
    try {
      await client.query("BEGIN");
      begun = true;
      await client.query("SELECT pg_advisory_xact_lock(54421, 24)");

      const scope = await client.query(
        `SELECT 1 FROM payment_projects p
         JOIN payment_merchants m ON m.project_id=p.id
         WHERE p.id=$1 AND p.status='active' AND m.id=$2 AND m.status='active'`,
        [this.options.projectId, this.options.merchantId]
      );
      if (scope.rowCount !== 1) throw new Error("Project or merchant is not active.");

      // These adapters do NOT begin/commit subtransactions. Their services
      // participate in exactly this one external PostgreSQL transaction.
      const paymentPort: PaymentPersistence = {
        transaction: async (work) => work(new PostgresPaymentTransaction(client))
      };
      const ledgerPort: LedgerPersistence = {
        transaction: async (work) => work(new PostgresLedgerTransaction(client))
      };
      const paymentService = new PaymentService({ persistence: paymentPort });
      const ledgerService = new LedgerService({ persistence: ledgerPort });

      const audit = await paymentService.getPaymentAudit(paymentId);
      if (!audit.ok) throw new Error(audit.error.message);
      const current = audit.value.payment;
      this.ensureIdentity(current);
      this.validateVerification(current, authoritative);

      const binding = await new PostgresPaymentTransaction(client).getProviderBinding(
        "fapshi", "sandbox", current.providerReference!
      );
      if (binding?.paymentId !== paymentId) {
        throw new Error("Fapshi provider reference is not bound to this payment.");
      }
      if (!["created", "pending", "authorized", "succeeded"].includes(current.status)) {
        throw new Error("Payment is in a terminal/conflicting state.");
      }

      if (current.status !== "succeeded") {
        const applied = await paymentService.ingestProviderEvent({
          provider: "fapshi",
          environment: "sandbox",
          eventId: `authoritative-success-${paymentId}`,
          providerPaymentReference: current.providerReference!,
          status: "succeeded",
          occurredAt: authoritative.verifiedAt
        });
        if (!applied.ok || applied.value.receipt.outcome !== "applied" ||
            applied.value.payment?.status !== "succeeded") {
          throw new Error("Authoritative payment transition was not applied.");
        }
      }

      // Use the first persisted success transition timestamp. Subsequent
      // verifier reads have new timestamps but must NOT create ledger conflicts.
      const updatedAudit = await paymentService.getPaymentAudit(paymentId);
      if (!updatedAudit.ok || updatedAudit.value.payment.status !== "succeeded") {
        throw new Error("Payment was not committed as succeeded.");
      }
      const firstSuccess = updatedAudit.value.transitions.find(
        (entry) => entry.toStatus === "succeeded"
      );
      if (!firstSuccess) throw new Error("Missing durable successful payment transition.");

      const { feeMinor, revenueMinor } = this.validateVerification(current, authoritative);
      const ledger = await ledgerService.recordPaymentBreakdown({
        projectId: current.projectId,
        merchantId: current.merchantId,
        paymentId: current.id,
        sourceKey: `fapshi:${paymentId}:confirmed:v1`,
        gross: current.amount,
        ...(feeMinor > 0 ? {
          providerFee: { amountMinor: feeMinor, currency: "XAF" }
        } : {}),
        merchantShare: { amountMinor: revenueMinor, currency: "XAF" },
        provider: "fapshi",
        providerReference: current.providerReference,
        occurredAt: firstSuccess.occurredAt,
        metadata: { providerStatus: "SUCCESSFUL", serviceName: this.options.expectedServiceName }
      });
      if (!ledger.ok) throw new Error(`Financial evidence conflict: ${ledger.error.message}`);

      // Notify only that an authoritative collection was confirmed, never
      // award pages/credits here. Précis must deduplicate this effect key and
      // match its OWN durable purchase/quote before granting entitlements.
      const outbox = await enqueueOutboxInTransaction(client, {
        projectId: current.projectId,
        paymentId: current.id,
        destination: "precis-payment-events",
        effectKey: `confirmed-${paymentId}`,
        payload: {
          eventType: "payment.confirmed",
          projectId: current.projectId,
          merchantId: current.merchantId,
          paymentId: current.id,
          externalReference: current.externalReference,
          provider: "fapshi",
          providerReference: current.providerReference,
          amountMinor: current.amount.amountMinor,
          currency: "XAF"
        }
      });
      await client.query("COMMIT");
      begun = false;

      return {
        paymentId,
        ledgerBatchId: ledger.value.batch.id,
        outboxId: outbox.id,
        replayed: current.status === "succeeded" && ledger.value.replayed && outbox.replayed
      };
    } catch (error) {
      if (begun) {
        try { await client.query("ROLLBACK"); } catch { /* preserve first error */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
