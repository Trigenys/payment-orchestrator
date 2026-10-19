import type { Pool, PoolClient } from "pg";
import type {
  ReconciliationPersistence, ReconciliationTransaction
} from "../../reconciliation/persistence.js";
import type { ReconciliationRun } from "../../reconciliation/types.js";

class PostgresReconciliationTransaction implements ReconciliationTransaction {
  constructor(private readonly client: PoolClient) {}

  async getRun(key: string): Promise<ReconciliationRun | undefined> {
    const found = await this.client.query<{ payload: ReconciliationRun }>(
      "SELECT payload FROM payment_reconciliation_runs WHERE run_key = $1",
      [key]
    );
    return found.rows[0]?.payload;
  }

  async appendRun(run: ReconciliationRun): Promise<void> {
    if (!run.key || !run.fingerprint || !run.projectId || !run.merchantId ||
        !run.subjectId || /\u0000/.test(run.key)) {
      throw new Error("Reconciliation run identity is invalid.");
    }
    const merchant = await this.client.query(
      "SELECT 1 FROM payment_merchants WHERE id=$1 AND project_id=$2",
      [run.merchantId, run.projectId]
    );
    if (merchant.rowCount !== 1) {
      throw new Error("Reconciliation merchant does not belong to project.");
    }
    await this.client.query(
      `INSERT INTO payment_reconciliation_runs
        (id,project_id,merchant_id,provider,subject_id,run_key,payload,checked_at)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,
      [
        run.id, run.projectId, run.merchantId, run.provider, run.subjectId,
        run.key, JSON.stringify(run), run.createdAt
      ]
    );
  }

  async listRuns(input: {
    readonly projectId: string;
    readonly merchantId?: string;
    readonly subjectId?: string;
  }): Promise<readonly ReconciliationRun[]> {
    if (!input.projectId) throw new Error("Reconciliation project scope is required.");
    const result = await this.client.query<{ payload: ReconciliationRun }>(
      `SELECT payload FROM payment_reconciliation_runs
       WHERE project_id = $1
         AND ($2::text IS NULL OR merchant_id = $2)
         AND ($3::text IS NULL OR subject_id = $3)
       ORDER BY checked_at ASC, id ASC`,
      [input.projectId, input.merchantId ?? null, input.subjectId ?? null]
    );
    return result.rows.map(row => row.payload);
  }
}

export class PostgresReconciliationPersistence implements ReconciliationPersistence {
  constructor(private readonly pool: Pool) {}

  async transaction<T>(work: (tx: ReconciliationTransaction) => Promise<T> | T): Promise<T> {
    const client = await this.pool.connect();
    let begun = false;
    try {
      await client.query("BEGIN");
      begun = true;
      await client.query("SELECT pg_advisory_xact_lock(54421, 24)");
      const result = await work(new PostgresReconciliationTransaction(client));
      await client.query("COMMIT");
      begun = false;
      return result;
    } catch (error) {
      if (begun) {
        try { await client.query("ROLLBACK"); } catch { /* preserve primary failure */ }
      }
      throw error;
    } finally {
      client.release();
    }
  }
}
