import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { Pool } from "pg";
import { reserveFapshiSandboxStatusRead } from "../src/api/fapshi-status-budget.js";
import { PostgresMessageStore } from "../src/storage/postgres/durable-messages.js";
import { migrate } from "../src/storage/postgres/migrate.js";

const url = process.env.POSTGRES_TEST_URL;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

test("shared Fapshi sandbox verification budget and authenticated inbox storage", {
  skip: url ? false : "POSTGRES_TEST_URL is not configured"
}, async t => {
  const pool = new Pool({ connectionString: url!, max: 10 });
  const otherPool = new Pool({ connectionString: url!, max: 10 });
  try {
    await migrate(pool);
    const transId = `fapshi-budget-${randomUUID()}`;
    const event = {
      provider: "fapshi",
      environment: "sandbox" as const,
      providerReference: transId,
      eventFingerprint: sha(`${transId}:SUCCESSFUL`),
      payloadDigest: sha("minimal-approved-data"),
      payload: { transId, status: "SUCCESSFUL", serviceName: "test-service" }
    };

    await t.test("concurrent independent inbox stores deduplicate same event", async () => {
      const stores = [new PostgresMessageStore(pool), new PostgresMessageStore(otherPool)];
      const receipts = await Promise.all(Array.from(
        { length: 12 }, (_, i) => stores[i % 2]!.recordInbox(event)
      ));
      assert.equal(receipts.filter(r => !r.replayed).length, 1);
      assert.equal(new Set(receipts.map(r => r.id)).size, 1);
      const stored = await pool.query<{
        payload: Record<string, unknown>
      }>(
        "SELECT payload FROM payment_webhook_inbox WHERE provider_reference=$1",
        [transId]
      );
      assert.equal(stored.rowCount, 1);
      assert.deepEqual(stored.rows[0]?.payload, event.payload);
    });

    await t.test("rolling budget grants at most five across two pools", async () => {
      const attempts = await Promise.all(Array.from(
        { length: 14 }, (_, i) =>
          reserveFapshiSandboxStatusRead(i % 2 ? pool : otherPool, transId)
      ));
      assert.equal(attempts.filter(Boolean).length, 5);
      assert.equal(attempts.filter(v => !v).length, 9);
      const count = await pool.query<{ n: number }>(
        "SELECT count(*)::int AS n FROM fapshi_status_attempts WHERE provider_reference=$1",
        [transId]
      );
      assert.equal(count.rows[0]?.n, 5);
      assert.equal(await reserveFapshiSandboxStatusRead(otherPool, transId), false);

      // Expiration is based on a real DB-clock rolling window, not process state.
      await pool.query(
        "UPDATE fapshi_status_attempts SET attempted_at=NOW()-INTERVAL '62 seconds' WHERE provider_reference=$1",
        [transId]
      );
      assert.equal(await reserveFapshiSandboxStatusRead(otherPool, transId), true);
    });

    await t.test("different transId budgets remain separate", async () => {
      assert.equal(await reserveFapshiSandboxStatusRead(pool, transId + "-other"), true);
      await assert.rejects(reserveFapshiSandboxStatusRead(pool, "bad/reference"), /Invalid Fapshi/);
    });
  } finally {
    await Promise.all([pool.end(), otherPool.end()]);
  }
});
