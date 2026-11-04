import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import pg from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

export const LOCAL_DATABASE_URL = "postgres://ebo:ebo@localhost:54329/ebo";

/**
 * TLS for the database. Vultr Managed PostgreSQL requires it; the local development database
 * doesn't use it. With DATABASE_CA_CERT (the PEM from the Vultr control panel) the server's
 * certificate is verified; without it the connection is encrypted but not verified.
 */
export function sslFor(url: string, caCert = process.env.DATABASE_CA_CERT): pg.PoolConfig["ssl"] {
  const u = new URL(url);
  const mode = u.searchParams.get("sslmode");
  if (mode === "disable" || ["localhost", "127.0.0.1"].includes(u.hostname)) return false;
  return caCert ? { ca: caCert.replace(/\\n/g, "\n"), rejectUnauthorized: true } : { rejectUnauthorized: false };
}

/** DB_POOL_MAX sets the default pool size (each open connection costs Postgres ~15 MB). */
export function createPool(url = process.env.DATABASE_URL ?? LOCAL_DATABASE_URL, max = Number(process.env.DB_POOL_MAX) || 10): pg.Pool {
  const clean = new URL(url);
  clean.searchParams.delete("sslmode"); // pg would otherwise override our ssl option
  return new pg.Pool({ connectionString: clean.toString(), ssl: sslFor(url), max });
}

export function createDb(pool: pg.Pool = createPool()): Db {
  return drizzle(pool, { schema });
}

const globalForDb = globalThis as unknown as { __eboPool?: pg.Pool; __eboDb?: Db };

/** One pool per process (Next.js dev reloads modules, so the pool is cached on globalThis). */
export function getDb(): Db {
  if (!globalForDb.__eboDb) {
    globalForDb.__eboPool = createPool();
    globalForDb.__eboDb = createDb(globalForDb.__eboPool);
  }
  return globalForDb.__eboDb;
}

export function getPool(): pg.Pool {
  getDb();
  return globalForDb.__eboPool!;
}
