import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";

export async function migrate(pool: Pool, directory = resolve("migrations")): Promise<void> {
  const files = (await readdir(directory))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/.test(name))
    .sort();

  const client = await pool.connect();
  let begun = false;
  try {
    await client.query("BEGIN");
    begun = true;
    await client.query("SELECT pg_advisory_xact_lock(54421, 100)");
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);

    for (const name of files) {
      const version = name.slice(0, -4);
      const exists = await client.query(
        "SELECT 1 FROM schema_migrations WHERE version = $1",
        [version]
      );
      if (exists.rowCount) continue;

      const sql = await readFile(resolve(directory, name), "utf8");
      await client.query(sql);
      await client.query(
        "INSERT INTO schema_migrations (version) VALUES ($1)",
        [version]
      );
    }

    await client.query("COMMIT");
    begun = false;
  } catch (error) {
    if (begun) await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1]?.endsWith("/migrate.js")) {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL must be configured for migrations.");
  }

  const pool = new Pool({ connectionString, max: 2 });
  try {
    await migrate(pool);
    process.stdout.write("PostgreSQL migrations applied.\n");
  } finally {
    await pool.end();
  }
}
