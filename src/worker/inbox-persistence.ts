import type { Pool } from "pg";
import type { ProviderEnvironment } from "../providers/capabilities.js";
import { parseFapshiEnvironment } from "../providers/fapshi/environment.js";

export interface InboxLease {
  readonly id: string;
  readonly providerReference: string;
  readonly status: "SUCCESSFUL" | "FAILED" | "EXPIRED";
  readonly attemptCount: number;
  readonly leaseToken: string;
}

/** Durable Fapshi inbox claims; scoped to one environment and service. */
export class PostgresInboxWorkerStore {
  constructor(private readonly pool: Pool, private readonly serviceName: string,
    private readonly environment: ProviderEnvironment = "sandbox") {
    parseFapshiEnvironment(environment);
    if (!serviceName.trim()) throw new Error("Worker service name is required.");
  }

  async claim(limit = 3, leaseSeconds = 120): Promise<readonly InboxLease[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10 ||
        !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 600) {
      throw new Error("Invalid inbox claim limits.");
    }
    const result = await this.pool.query<{
      id: string; provider_reference: string; provider_status: string;
      attempt_count: number; lease_token: string;
    }>(
      `WITH claimed AS (
        SELECT id FROM payment_webhook_inbox
        WHERE provider='fapshi' AND environment=$4
          AND payload->>'serviceName' = $1
          AND (
            (status='received' AND next_attempt_at <= now()) OR
            (status='processing' AND leased_until < now())
          )
        ORDER BY next_attempt_at, received_at, id
        FOR UPDATE SKIP LOCKED LIMIT $2
      )
      UPDATE payment_webhook_inbox AS i SET
        status='processing', attempt_count=i.attempt_count+1,
        leased_until=now()+($3::integer * INTERVAL '1 second'),
        lease_token=gen_random_uuid()::text, updated_at=now()
      FROM claimed WHERE i.id=claimed.id
      RETURNING i.id, i.provider_reference, i.payload->>'status' AS provider_status,
        i.attempt_count, i.lease_token`,
      [this.serviceName, limit, leaseSeconds, this.environment]
    );
    return result.rows.map(row => {
      if (!["SUCCESSFUL", "FAILED", "EXPIRED"].includes(row.provider_status)) {
        throw new Error("Invalid stored Fapshi inbox event status.");
      }
      return {
        id: row.id,
        providerReference: row.provider_reference,
        status: row.provider_status as InboxLease["status"],
        attemptCount: row.attempt_count,
        leaseToken: row.lease_token
      };
    });
  }

  async complete(lease: InboxLease): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE payment_webhook_inbox
       SET status='processed', processed_at=now(), leased_until=NULL,
           lease_token=NULL, last_error_code=NULL, updated_at=now()
       WHERE id=$1 AND lease_token=$2 AND status='processing' AND leased_until>now()
         AND provider='fapshi' AND environment=$3`,
      [lease.id, lease.leaseToken, this.environment]
    );
    return result.rowCount === 1;
  }

  /**
   * Fenced retry; only the current, unexpired lease can reschedule.
   * A retry limit quarantines rather than silently dropping the message.
   */
  async retry(lease: InboxLease, reason: string, delaySeconds: number, maxAttempts = 6):
    Promise<"retry_scheduled" | "quarantined" | "stale_lease"> {
    if (!/^[A-Z0-9_]{1,48}$/.test(reason) ||
        !Number.isSafeInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 86400 ||
        !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
      throw new Error("Invalid inbox retry parameters.");
    }
    const result = await this.pool.query<{ status: string }>(
      `UPDATE payment_webhook_inbox
       SET status=CASE WHEN attempt_count >= $4 THEN 'quarantined' ELSE 'received' END,
           next_attempt_at=now()+($5::integer * INTERVAL '1 second'),
           last_error_code=$3, lease_token=NULL, leased_until=NULL, updated_at=now()
       WHERE id=$1 AND lease_token=$2 AND status='processing' AND leased_until>now()
         AND provider='fapshi' AND environment=$6
       RETURNING status`,
      [lease.id, lease.leaseToken, reason, maxAttempts, delaySeconds, this.environment]
    );
    if (!result.rows[0]) return "stale_lease";
    return result.rows[0].status === "quarantined" ? "quarantined" : "retry_scheduled";
  }

  /**
   * A shared PSP read budget denial is NOT a failed processing attempt.
   * Reschedule without eating the failure budget.
   */
  async deferRateLimit(lease: InboxLease, delaySeconds = 75): Promise<boolean> {
    if (!Number.isSafeInteger(delaySeconds) || delaySeconds < 60 || delaySeconds > 3600) {
      throw new Error("Invalid provider backoff.");
    }
    const result = await this.pool.query(
      `UPDATE payment_webhook_inbox SET status='received',
         attempt_count=GREATEST(attempt_count-1,0),
         next_attempt_at=now()+($3::integer * INTERVAL '1 second'),
         last_error_code='PSP_BUDGET', lease_token=NULL, leased_until=NULL, updated_at=now()
       WHERE id=$1 AND lease_token=$2 AND status='processing' AND leased_until>now()
         AND provider='fapshi' AND environment=$4`,
      [lease.id, lease.leaseToken, delaySeconds, this.environment]
    );
    return result.rowCount === 1;
  }

  async findBoundPayment(providerReference: string, projectId: string, merchantId: string):
    Promise<string | undefined> {
    const found = await this.pool.query<{ payment_id: string }>(
      `SELECT b.payment_id
       FROM payment_provider_bindings b
       INNER JOIN payment_intents p ON p.id=b.payment_id
       WHERE b.provider='fapshi' AND b.environment=$4
         AND b.provider_payment_reference=$1
         AND p.project_id=$2 AND p.merchant_id=$3
         AND p.status IN ('created','pending','authorized','succeeded')`,
      [providerReference, projectId, merchantId, this.environment]
    );
    return found.rows[0]?.payment_id;
  }
}
