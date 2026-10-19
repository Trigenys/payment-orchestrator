import type { Pool, PoolClient } from "pg";

/** PostgreSQL TEXT cannot contain NUL. Domain composite event keys use it. */
function safeCompositeKey(value: string): string {
  return Buffer.from(value, "utf8").toString("hex");
}

import type { Payment } from "../../domain/models.js";
import type { ProviderEnvironment } from "../../providers/capabilities.js";
import {
  type PaymentPersistence,
  type PaymentTransaction
} from "../../payments/persistence.js";
import type {
  PaymentCreationReservation,
  PaymentTransitionEvidence,
  ProviderEventReceipt,
  ProviderReferenceBinding
} from "../../payments/types.js";

/**
 * PostgreSQL transaction port for the existing PaymentService.
 *
 * A transaction-scoped advisory lock serializes all payment state mutations
 * across API/worker processes while the pilot is small. This deliberately
 * favors auditability over throughput; replace with per-intent locks, proven
 * under concurrent tests, before broad marketplace use. Every write commits
 * or rolls back together, and even a crashed process releases the lock.
 *
 * PostgreSQL must be migrated and project/merchant identities provisioned
 * BEFORE the PaymentService creates any intent.
 */
class PostgresPaymentTransaction implements PaymentTransaction {
  constructor(private readonly client: PoolClient) {}

  async getPayment(paymentId: string): Promise<Payment | undefined> {
    const result = await this.client.query<{ payload: Payment }>(
      "SELECT payload FROM payment_intents WHERE id = $1",
      [paymentId]
    );
    return result.rows[0]?.payload;
  }

  async putPayment(payment: Payment): Promise<void> {
    if (
      !Number.isSafeInteger(payment.amount.amountMinor) ||
      payment.amount.amountMinor <= 0 ||
      !/^[A-Z]{3}$/.test(payment.amount.currency)
    ) {
      throw new Error("Cannot persist an invalid payment amount.");
    }

    const result = await this.client.query(
      `INSERT INTO payment_intents (
        id, project_id, merchant_id, provider_account_id,
        external_reference, amount_minor, currency, status, version,
        payload, created_at, updated_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        version = EXCLUDED.version,
        payload = EXCLUDED.payload,
        updated_at = EXCLUDED.updated_at
      WHERE payment_intents.version < EXCLUDED.version
        AND payment_intents.project_id = EXCLUDED.project_id
        AND payment_intents.merchant_id = EXCLUDED.merchant_id
        AND payment_intents.external_reference = EXCLUDED.external_reference
        AND payment_intents.amount_minor = EXCLUDED.amount_minor
        AND payment_intents.currency = EXCLUDED.currency
        AND payment_intents.provider_account_id IS NOT DISTINCT FROM EXCLUDED.provider_account_id`,
      [
        payment.id, payment.projectId, payment.merchantId,
        payment.providerAccountId ?? null, payment.externalReference,
        payment.amount.amountMinor, payment.amount.currency,
        payment.status, payment.version, JSON.stringify(payment),
        payment.createdAt, payment.updatedAt
      ]
    );
    if (result.rowCount !== 1) {
      throw new Error("Payment write rejected: stale version or immutable identity changed.");
    }
  }

  async getCreation(
    projectId: string,
    idempotencyKey: string
  ): Promise<PaymentCreationReservation | undefined> {
    const result = await this.client.query<{
      project_id: string;
      idempotency_key: string;
      fingerprint: string;
      payment_id: string;
      created_at: Date;
    }>(
      `SELECT project_id, idempotency_key, fingerprint, payment_id, created_at
       FROM payment_creation_reservations
       WHERE project_id = $1 AND idempotency_key = $2`,
      [projectId, idempotencyKey]
    );
    const row = result.rows[0];
    return row ? {
      projectId: row.project_id,
      idempotencyKey: row.idempotency_key,
      fingerprint: row.fingerprint,
      paymentId: row.payment_id,
      createdAt: row.created_at.toISOString()
    } : undefined;
  }

  async putCreation(reservation: PaymentCreationReservation): Promise<void> {
    await this.client.query(
      `INSERT INTO payment_creation_reservations
       (project_id, idempotency_key, fingerprint, payment_id, created_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        reservation.projectId, reservation.idempotencyKey,
        reservation.fingerprint, reservation.paymentId, reservation.createdAt
      ]
    );
  }

  async getProviderBinding(
    provider: string,
    environment: ProviderEnvironment,
    providerPaymentReference: string
  ): Promise<ProviderReferenceBinding | undefined> {
    const result = await this.client.query<{
      provider: string;
      environment: ProviderEnvironment;
      provider_payment_reference: string;
      payment_id: string;
      bound_at: Date;
    }>(
      `SELECT provider, environment, provider_payment_reference, payment_id, bound_at
       FROM payment_provider_bindings
       WHERE provider = $1 AND environment = $2 AND provider_payment_reference = $3`,
      [provider.trim().toLowerCase(), environment, providerPaymentReference.trim()]
    );
    const row = result.rows[0];
    return row ? {
      provider: row.provider,
      environment: row.environment,
      providerPaymentReference: row.provider_payment_reference,
      paymentId: row.payment_id,
      boundAt: row.bound_at.toISOString()
    } : undefined;
  }

  async putProviderBinding(binding: ProviderReferenceBinding): Promise<void> {
    await this.client.query(
      `INSERT INTO payment_provider_bindings
       (provider, environment, provider_payment_reference, payment_id, bound_at)
       VALUES ($1,$2,$3,$4,$5)`,
      [
        binding.provider.trim().toLowerCase(), binding.environment,
        binding.providerPaymentReference.trim(), binding.paymentId,
        binding.boundAt
      ]
    );
  }

  async getProviderEvent(key: string): Promise<ProviderEventReceipt | undefined> {
    const result = await this.client.query<{ payload: ProviderEventReceipt }>(
      "SELECT payload FROM payment_provider_events WHERE event_key = $1",
      [safeCompositeKey(key)]
    );
    return result.rows[0]?.payload;
  }

  async putProviderEvent(receipt: ProviderEventReceipt): Promise<void> {
    await this.client.query(
      `INSERT INTO payment_provider_events
       (event_key, fingerprint, provider, environment, event_id, payment_id,
        received_at, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
      [
        safeCompositeKey(receipt.key), receipt.fingerprint, receipt.provider,
        receipt.environment, receipt.eventId, receipt.paymentId ?? null,
        receipt.receivedAt, JSON.stringify(receipt)
      ]
    );
  }

  async putTransition(transition: PaymentTransitionEvidence): Promise<void> {
    await this.client.query(
      `INSERT INTO payment_transitions
       (id, payment_id, source, source_id, occurred_at, payload)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [
        transition.id, transition.paymentId, transition.source,
        safeCompositeKey(transition.sourceId), transition.occurredAt, JSON.stringify(transition)
      ]
    );
  }

  async listTransitions(paymentId: string): Promise<readonly PaymentTransitionEvidence[]> {
    const result = await this.client.query<{ payload: PaymentTransitionEvidence }>(
      `SELECT payload FROM payment_transitions
       WHERE payment_id = $1 ORDER BY sequence ASC`,
      [paymentId]
    );
    return result.rows.map((row) => row.payload);
  }

  async listProviderEvents(paymentId: string): Promise<readonly ProviderEventReceipt[]> {
    const result = await this.client.query<{ payload: ProviderEventReceipt }>(
      `SELECT payload FROM payment_provider_events
       WHERE payment_id = $1 ORDER BY received_at ASC, event_key ASC`,
      [paymentId]
    );
    return result.rows.map((row) => row.payload);
  }
}

export class PostgresPaymentPersistence implements PaymentPersistence {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(
    work: (transaction: PaymentTransaction) => Promise<T> | T
  ): Promise<T> {
    const client = await this.pool.connect();
    let begun = false;
    try {
      await client.query("BEGIN");
      begun = true;

      // Phase 1: low-volume pilot. A DB-level lock also serializes workers on
      // distinct app instances. The application is NOT ready for high throughput.
      await client.query("SELECT pg_advisory_xact_lock(54421, 24)");
      const result = await work(new PostgresPaymentTransaction(client));
      await client.query("COMMIT");
      begun = false;
      return result;
    } catch (error) {
      if (begun) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve original error, pool client will still be released.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Called only from a separate readiness endpoint, never /health liveness. */
export async function checkPostgresReadiness(pool: Pool): Promise<boolean> {
  try {
    const result = await pool.query<{ version: string }>(
      "SELECT version FROM schema_migrations WHERE version = '001_payment_core'"
    );
    return result.rowCount === 1;
  } catch {
    return false;
  }
}
