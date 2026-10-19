import type { Pool } from "pg";

/**
 * Transactionally reserve an attempt BEFORE issuing the external request.
 * Counts even when the HTTP request fails. The global advisory lock protects
 * the budget across API replicas, not only within one Node process.
 *
 * 5 per rolling minute is deliberately below the documented Fapshi limit (6).
 * Other independent clients using the same Fapshi credentials still need to
 * coordinate externally; do not run another unaudited verification poller.
 */
export async function reserveFapshiSandboxStatusRead(
  pool: Pool,
  providerReference: string
): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{1,160}$/.test(providerReference)) {
    throw new Error("Invalid Fapshi provider reference.");
  }
  const client = await pool.connect();
  let begun = false;
  try {
    await client.query("BEGIN");
    begun = true;
    await client.query("SELECT pg_advisory_xact_lock(54421,27)");
    const count = await client.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM fapshi_status_attempts
       WHERE environment='sandbox' AND provider_reference=$1
         AND attempted_at > NOW() - INTERVAL '60 seconds'`,
      [providerReference]
    );
    if (Number(count.rows[0]?.count ?? 0) >= 5) {
      await client.query("COMMIT");
      begun = false;
      return false;
    }
    await client.query(
      `INSERT INTO fapshi_status_attempts(environment,provider_reference)
       VALUES('sandbox',$1)`,
      [providerReference]
    );
    await client.query("COMMIT");
    begun = false;
    return true;
  } catch (error) {
    if (begun) {
      try { await client.query("ROLLBACK"); } catch { /* preserve the first error */ }
    }
    throw error;
  } finally {
    client.release();
  }
}
