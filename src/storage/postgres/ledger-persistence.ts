import type { Pool, PoolClient } from "pg";
import type { LedgerPersistence, LedgerTransaction } from "../../ledger/persistence.js";
import type { LedgerBatch, LedgerEntry, LedgerScope } from "../../ledger/types.js";

/**
 * Financial evidence is append-only. Every batch is transactional and keyed
 * by (projectId, sourceKey), so duplicate worker invocations return a replay.
 */
export class PostgresLedgerTransaction implements LedgerTransaction {
  constructor(private readonly client: PoolClient) {}

  async getBatch(projectId: string, sourceKey: string): Promise<LedgerBatch | undefined> {
    const found = await this.client.query<{ payload: LedgerBatch }>(
      "SELECT payload FROM payment_ledger_batches WHERE project_id = $1 AND source_key = $2",
      [projectId, sourceKey]
    );
    return found.rows[0]?.payload;
  }

  async appendBatch(batch: LedgerBatch, entries: readonly LedgerEntry[]): Promise<void> {
    if (batch.entryIds.length !== entries.length ||
        !entries.every((entry, index) => entry.id === batch.entryIds[index] &&
          entry.batchId === batch.id && entry.projectId === batch.projectId &&
          entry.merchantId === batch.merchantId && entry.paymentId === batch.paymentId &&
          entry.settlementId === batch.settlementId &&
          Number.isSafeInteger(entry.amount.amountMinor) &&
          entry.amount.amountMinor > 0 && /^[A-Z]{3}$/.test(entry.amount.currency))) {
      throw new Error("Ledger batch and entry identities, amounts or order do not match.");
    }
    if (!batch.projectId || !batch.merchantId || !batch.sourceKey || !batch.fingerprint ||
        /\u0000/.test(batch.sourceKey) || /\u0000/.test(batch.projectId)) {
      throw new Error("Invalid ledger batch scope or source key.");
    }

    // Reject cross-tenant evidence even if the project exists separately.
    const merchant = await this.client.query(
      "SELECT 1 FROM payment_merchants WHERE id=$1 AND project_id=$2",
      [batch.merchantId, batch.projectId]
    );
    if (merchant.rowCount !== 1) {
      throw new Error("Ledger merchant does not belong to the supplied project.");
    }

    if (batch.paymentId) {
      const payment = await this.client.query(
        "SELECT 1 FROM payment_intents WHERE id=$1 AND project_id=$2 AND merchant_id=$3",
        [batch.paymentId, batch.projectId, batch.merchantId]
      );
      if (payment.rowCount !== 1) {
        throw new Error("Ledger payment does not belong to the supplied project/merchant.");
      }
    }

    await this.client.query(
      `INSERT INTO payment_ledger_batches(id, project_id, source_key, payload)
       VALUES ($1,$2,$3,$4::jsonb)`,
      [batch.id, batch.projectId, batch.sourceKey, JSON.stringify(batch)]
    );

    for (const entry of entries) {
      await this.client.query(
        `INSERT INTO payment_ledger_entries(
          id,batch_id,project_id,merchant_id,payment_id,kind,
          amount_minor,currency,payload
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
        [
          entry.id, batch.id, batch.projectId, batch.merchantId,
          batch.paymentId ?? null, entry.kind,
          entry.amount.amountMinor, entry.amount.currency, JSON.stringify(entry)
        ]
      );
    }
  }

  async listEntries(scope: LedgerScope): Promise<readonly LedgerEntry[]> {
    if (!scope.projectId) throw new Error("Ledger project scope is required.");
    const result = await this.client.query<{ payload: LedgerEntry }>(
      `SELECT e.payload FROM payment_ledger_entries e
       WHERE e.project_id = $1
         AND ($2::text IS NULL OR e.merchant_id = $2)
         AND ($3::text IS NULL OR e.payment_id = $3)
       ORDER BY e.id ASC`,
      [scope.projectId, scope.merchantId ?? null, scope.paymentId ?? null]
    );
    return result.rows.map((row) => row.payload);
  }
}

export class PostgresLedgerPersistence implements LedgerPersistence {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(work: (tx: LedgerTransaction) => Promise<T> | T): Promise<T> {
    const client = await this.pool.connect();
    let begun = false;
    try {
      await client.query("BEGIN");
      begun = true;
      // Same coarse transaction lock as the payment port, for the bounded pilot.
      await client.query("SELECT pg_advisory_xact_lock(54421, 24)");
      const output = await work(new PostgresLedgerTransaction(client));
      await client.query("COMMIT");
      begun = false;
      return output;
    } catch (error) {
      if (begun) {
        try { await client.query("ROLLBACK"); } catch { /* connection is released */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
