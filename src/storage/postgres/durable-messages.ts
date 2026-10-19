import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { ledgerFingerprint } from "../../ledger/fingerprint.js";
import type { ProviderEnvironment } from "../../providers/capabilities.js";

export interface InboxInput {
  readonly provider: string;
  readonly environment: ProviderEnvironment;
  readonly providerReference: string;
  /** Stable digest of a normalized event; Fapshi does not supply an event ID. */
  readonly eventFingerprint: string;
  readonly payloadDigest: string;
  /** Privacy-reviewed event metadata ONLY, never raw credentials or phone data. */
  readonly payload: Readonly<Record<string, unknown>>;
}
export interface InboxReceipt {
  readonly id: string;
  readonly replayed: boolean;
  readonly status: "received" | "processing" | "processed" | "quarantined";
}

export interface OutboxInput {
  readonly projectId: string;
  readonly paymentId: string;
  /** An internal, allowed consumer route (NOT an arbitrary URL). */
  readonly destination: string;
  /** A stable one-grant-per-order effect key. */
  readonly effectKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
}
export interface OutboxReceipt {
  readonly id: string;
  readonly replayed: boolean;
}
export interface LeasedOutboxDelivery {
  readonly id: string;
  readonly projectId: string;
  readonly paymentId: string;
  readonly destination: string;
  readonly effectKey: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly attemptCount: number;
  readonly leaseToken: string;
}

function validRef(input: string, max = 160): boolean {
  return /^[a-zA-Z0-9_:/.-]+$/.test(input) && input.length <= max;
}
function validatePayload(payload: Readonly<Record<string, unknown>>): void {
  const serialized = JSON.stringify(payload);
  if (!serialized || Buffer.byteLength(serialized, "utf8") > 16_384 || serialized.includes("\\u0000")) {
    throw new Error("Message payload must be structured, bounded and NUL-free.");
  }
}
function hexDigest(digest: string): boolean {
  return /^[a-f0-9]{64}$/.test(digest);
}

/**
 * Persist the business effect inside an EXTERNAL transaction with the verified
 * payment transition and ledger posting. It MUST NOT be called after COMMIT to
 * simulate atomicity. A future unit-of-work will own this call and the others.
 */
export async function enqueueOutboxInTransaction(
  client: PoolClient,
  input: OutboxInput
): Promise<OutboxReceipt> {
  if (!validRef(input.projectId) || !validRef(input.paymentId) ||
      !validRef(input.effectKey) || !/^[a-z0-9_-]{1,64}$/.test(input.destination)) {
    throw new Error("Invalid outbox scope or destination.");
  }
  validatePayload(input.payload);
  const scope = await client.query(
    "SELECT 1 FROM payment_intents WHERE id=$1 AND project_id=$2",
    [input.paymentId, input.projectId]
  );
  if (scope.rowCount !== 1) throw new Error("Outbox payment/project scope mismatch.");

  const proposedId = randomUUID();
  const created = await client.query<{ id: string }>(
    `INSERT INTO payment_outbox
      (id,project_id,payment_id,effect_key,destination,payload)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb)
     ON CONFLICT(project_id,destination,effect_key) DO NOTHING RETURNING id`,
    [
      proposedId, input.projectId, input.paymentId, input.effectKey,
      input.destination, JSON.stringify(input.payload)
    ]
  );
  if (created.rows[0]) return { id: created.rows[0].id, replayed: false };
  const existing = await client.query<{
    id: string; payment_id: string; payload: Record<string, unknown>
  }>(
    `SELECT id,payment_id,payload FROM payment_outbox
     WHERE project_id=$1 AND destination=$2 AND effect_key=$3`,
    [input.projectId, input.destination, input.effectKey]
  );
  const row = existing.rows[0];
  if (!row || row.payment_id !== input.paymentId ||
      ledgerFingerprint(row.payload) !== ledgerFingerprint(input.payload)) {
    throw new Error("Outbox effect key conflict with different financial evidence.");
  }
  return { id: row.id, replayed: true };
}

/**
 * Only records and leases messages. This module does NOT authenticate a
 * webhook, verify a PSP payment or deliver network requests.
 */
export class PostgresMessageStore {
  constructor(private readonly pool: Pool) {}

  async recordInbox(input: InboxInput): Promise<InboxReceipt> {
    if (!validRef(input.provider) || !validRef(input.providerReference) ||
        !hexDigest(input.eventFingerprint) || !hexDigest(input.payloadDigest)) {
      throw new Error("Invalid inbox event metadata.");
    }
    validatePayload(input.payload);
    const incomingId = randomUUID();
    const insert = await this.pool.query<{ id: string; status: InboxReceipt["status"] }>(
      `INSERT INTO payment_webhook_inbox
      (id,provider,environment,provider_reference,event_fingerprint,payload_digest,payload)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
      ON CONFLICT(provider,environment,event_fingerprint) DO NOTHING
      RETURNING id,status`,
      [
        incomingId, input.provider, input.environment, input.providerReference,
        input.eventFingerprint, input.payloadDigest, JSON.stringify(input.payload)
      ]
    );
    if (insert.rows[0]) {
      return { ...insert.rows[0], replayed: false };
    }
    const existing = await this.pool.query<{
      id: string; status: InboxReceipt["status"];
      payload_digest: string; provider_reference: string
    }>(
      `SELECT id,status,payload_digest,provider_reference FROM payment_webhook_inbox
       WHERE provider=$1 AND environment=$2 AND event_fingerprint=$3`,
      [input.provider, input.environment, input.eventFingerprint]
    );
    const row = existing.rows[0];
    if (!row || row.payload_digest !== input.payloadDigest ||
        row.provider_reference !== input.providerReference) {
      throw new Error("Incoming webhook fingerprint collides with conflicting content.");
    }
    return { id: row.id, status: row.status, replayed: true };
  }

  async enqueue(input: OutboxInput): Promise<OutboxReceipt> {
    const client = await this.pool.connect();
    let begun = false;
    try {
      await client.query("BEGIN");
      begun = true;
      const result = await enqueueOutboxInTransaction(client, input);
      await client.query("COMMIT");
      begun = false;
      return result;
    } catch (error) {
      if (begun) {
        try { await client.query("ROLLBACK"); } catch { /* preserve error */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }

  /** Queue claims use row locking; workers cannot claim the same job twice. */
  async lease(projectId: string, maximum = 10, leaseSeconds = 60): Promise<readonly LeasedOutboxDelivery[]> {
    if (!validRef(projectId) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 50 ||
        !Number.isSafeInteger(leaseSeconds) || leaseSeconds < 10 || leaseSeconds > 3600) {
      throw new Error("Invalid worker lease arguments.");
    }
    const rows = await this.pool.query<{
      id: string; project_id: string; payment_id: string; destination: string;
      effect_key: string; payload: Readonly<Record<string, unknown>>;
      attempt_count: number; lease_token: string
    }>(
      `WITH claimed AS (
         SELECT id FROM payment_outbox WHERE project_id=$1 AND (
           (status='pending' AND next_attempt_at <= NOW()) OR
           (status='leased' AND leased_until < NOW())
         )
         ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT $2
       )
       UPDATE payment_outbox job SET status='leased',
         attempt_count=job.attempt_count+1,
         lease_token=gen_random_uuid()::text,
         leased_until=NOW()+($3::integer * INTERVAL '1 second'),
         updated_at=NOW()
       FROM claimed WHERE job.id=claimed.id
       RETURNING job.id,job.project_id,job.payment_id,job.destination,
                 job.effect_key,job.payload,job.attempt_count,job.lease_token`,
      [projectId, maximum, leaseSeconds]
    );
    return rows.rows.map(row => ({
      id: row.id, projectId: row.project_id, paymentId: row.payment_id,
      destination: row.destination, effectKey: row.effect_key,
      payload: row.payload, attemptCount: row.attempt_count,
      leaseToken: row.lease_token
    }));
  }

  /** Only the active lease holder may acknowledge a delivery. */
  async acknowledge(id: string, leaseToken: string): Promise<boolean> {
    if (!validRef(id) || !validRef(leaseToken)) return false;
    const result = await this.pool.query(
      `UPDATE payment_outbox
       SET status='delivered',lease_token=NULL,leased_until=NULL,updated_at=NOW()
       WHERE id=$1 AND lease_token=$2 AND status='leased' AND leased_until>NOW()`,
      [id, leaseToken]
    );
    return result.rowCount === 1;
  }

  async retryOrQuarantine(
    id: string,
    leaseToken: string,
    failureCode: string,
    delaySeconds: number,
    maxAttempts = 5
  ): Promise<"retry_scheduled" | "dead_letter" | "stale_lease"> {
    if (!validRef(id) || !validRef(leaseToken) ||
        !/^[A-Z0-9_]{1,48}$/.test(failureCode) ||
        !Number.isSafeInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 86_400 ||
        !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
      throw new Error("Invalid retry controls.");
    }
    const result = await this.pool.query<{ status: string }>(
      `UPDATE payment_outbox SET
         status=CASE WHEN attempt_count >= $4 THEN 'dead_letter' ELSE 'pending' END,
         next_attempt_at=NOW()+($5::integer * INTERVAL '1 second'),
         lease_token=NULL,leased_until=NULL,last_failure_code=$3,updated_at=NOW()
       WHERE id=$1 AND lease_token=$2 AND status='leased' AND leased_until>NOW()
       RETURNING status`,
      [id, leaseToken, failureCode, maxAttempts, delaySeconds]
    );
    if (!result.rows[0]) return "stale_lease";
    return result.rows[0].status === "dead_letter" ? "dead_letter" : "retry_scheduled";
  }
}
