import { migrate } from "drizzle-orm/node-postgres/migrator";
import { resolve } from "node:path";
import { createDb, createPool } from "./client";
import { loadLocalEnv } from "./env";

/** Applies pending migrations. Coolify runs this before starting the app on every deploy. */
export async function runMigrations(url?: string): Promise<void> {
  const pool = createPool(url, 1);
  try {
    await migrate(createDb(pool), { migrationsFolder: resolve(import.meta.dirname, "../drizzle") });
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop()!)) {
  loadLocalEnv();
  runMigrations()
    .then(() => console.log("migrations applied"))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
