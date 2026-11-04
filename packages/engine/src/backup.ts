import { gunzipSync, gzipSync } from "node:zlib";
import type { PgClient, PgPool, Storage, StoredObject } from "@ebo/db";
import { openBackup, sealBackup } from "./secrets";

/**
 * Backups and restore (main doc W33). Every night the worker writes the whole database (the
 * app's tables in the public schema, not the job queue) to the backups bucket in Object
 * Storage as one gzipped file sealed with AES-256-GCM.
 *
 * Postgres renders each row as JSON and reads it back with json_populate_recordset, so every
 * value round-trips exactly (amounts are never parsed by JavaScript), and no pg_dump binary
 * has to match the server's version. A restore goes into a new database migrated to the same
 * release, and refuses a database that already has data in it.
 */

type Env = Record<string, string | undefined>;
type Pool = PgPool;
type Client = PgClient;

export const BACKUP_PREFIX = "db";
const FORMAT = "ebo-backup";
const VERSION = 1;
const BATCH = 500;

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** The app's tables, parents before children, from the database's own foreign keys. */
async function tablesInOrder(client: Client): Promise<string[]> {
  const tables = (await client.query<{ name: string }>(`select c.relname as name from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' order by 1`)).rows.map((r) => r.name);
  const edges = (
    await client.query<{ child: string; parent: string }>(
      `select ch.relname as child, pa.relname as parent from pg_constraint co
       join pg_class ch on ch.oid = co.conrelid join pg_class pa on pa.oid = co.confrelid join pg_namespace n on n.oid = ch.relnamespace
       where co.contype = 'f' and n.nspname = 'public' and co.conrelid <> co.confrelid`,
    )
  ).rows;
  const parents = new Map(tables.map((t) => [t, new Set<string>()]));
  for (const e of edges) parents.get(e.child)?.add(e.parent);
  const order: string[] = [];
  const left = new Set(tables);
  while (left.size) {
    const ready = [...left].filter((t) => [...parents.get(t)!].every((p) => !left.has(p)));
    if (!ready.length) throw new Error(`Can't order these tables by their foreign keys: ${[...left].join(", ")}.`);
    for (const t of ready) {
      order.push(t);
      left.delete(t);
    }
  }
  return order;
}

async function migrationsApplied(client: Client): Promise<number> {
  const { rows } = await client.query<{ t: string | null }>(`select to_regclass('drizzle.__drizzle_migrations')::text as t`);
  if (!rows[0]?.t) return 0;
  return (await client.query<{ n: number }>(`select count(*)::int as n from drizzle.__drizzle_migrations`)).rows[0]!.n;
}

export interface Dump {
  /** Gzipped: a header line, then "#table <name>" and one JSON row per line. */
  body: Buffer;
  rows: Record<string, number>;
  migrations: number;
  createdAt: string;
}

/** Reads every table from one consistent snapshot, even while runs are writing. */
export async function dumpDatabase(pool: Pool, now = new Date()): Promise<Dump> {
  const client = await pool.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    const tables = await tablesInOrder(client);
    const migrations = await migrationsApplied(client);
    const createdAt = now.toISOString();
    const lines = [`#${FORMAT} ${JSON.stringify({ version: VERSION, createdAt, migrations, tables })}`];
    const rows: Record<string, number> = {};
    for (const t of tables) {
      lines.push(`#table ${t}`);
      // A raw line break can only be JSON whitespace (inside strings they're escaped), so a space keeps one row per line.
      await client.query(`declare backup_rows no scroll cursor for select translate(row_to_json(t)::text, E'\\n\\r', '  ') as j from public.${ident(t)} t`);
      let n = 0;
      for (;;) {
        const page = await client.query<{ j: string }>(`fetch ${BATCH * 4} from backup_rows`);
        for (const r of page.rows) lines.push(r.j);
        n += page.rows.length;
        if (page.rows.length < BATCH * 4) break;
      }
      await client.query("close backup_rows");
      rows[t] = n;
    }
    await client.query("commit");
    return { body: gzipSync(lines.join("\n")), rows, migrations, createdAt };
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Loads a dump into an empty database that has been migrated to the same release. All or nothing. */
export async function restoreDatabase(pool: Pool, body: Uint8Array): Promise<{ rows: Record<string, number>; createdAt: string }> {
  const lines = gunzipSync(body).toString("utf8").split("\n");
  const head = lines[0] ?? "";
  if (!head.startsWith(`#${FORMAT} `)) throw new Error("This isn't a database backup made by this app.");
  const header = JSON.parse(head.slice(FORMAT.length + 2)) as { version: number; createdAt: string; migrations: number; tables: string[] };
  if (header.version !== VERSION) throw new Error(`This backup is format ${header.version}; this release reads format ${VERSION}.`);

  const client = await pool.connect();
  try {
    await client.query("begin");
    const migrations = await migrationsApplied(client);
    if (migrations !== header.migrations) {
      throw new Error(`The backup was taken with ${header.migrations} migrations applied, and the target database has ${migrations}. Migrate a new database with the same release first.`);
    }
    const tables = await tablesInOrder(client);
    const missing = header.tables.filter((t) => !tables.includes(t));
    if (missing.length) throw new Error(`The target database has no table ${missing.join(", ")}.`);
    for (const t of tables) {
      const { rows } = await client.query<{ has: boolean }>(`select exists (select 1 from public.${ident(t)}) as has`);
      if (rows[0]!.has) throw new Error(`The target database already has data (in ${t}). Restore into a new, migrated database.`);
    }

    const counts: Record<string, number> = {};
    let table: string | null = null;
    let cols = "";
    let batch: string[] = [];
    const flush = async () => {
      if (!table || !batch.length) return;
      await client.query(`insert into public.${ident(table)} (${cols}) select ${cols} from json_populate_recordset(null::public.${ident(table)}, $1::json)`, [`[${batch.join(",")}]`]);
      counts[table] = (counts[table] ?? 0) + batch.length;
      batch = [];
    };
    for (const line of lines.slice(1)) {
      if (line.startsWith("#table ")) {
        await flush();
        table = line.slice("#table ".length);
        if (!header.tables.includes(table)) throw new Error(`The backup is damaged: unexpected table ${table}.`);
        counts[table] = 0;
        const columns = await client.query<{ c: string }>(`select column_name as c from information_schema.columns where table_schema = 'public' and table_name = $1 and is_generated = 'NEVER' order by ordinal_position`, [table]);
        cols = columns.rows.map((r) => ident(r.c)).join(", ");
      } else if (line) {
        if (!table) throw new Error("The backup is damaged: a row before any table.");
        batch.push(line);
        if (batch.length >= BATCH) await flush();
      }
    }
    await flush();

    // Sequences (the audit log's ids) continue after the restored rows.
    const serials = await client.query<{ t: string; c: string }>(`select table_name as t, column_name as c from information_schema.columns where table_schema = 'public' and column_default like 'nextval(%'`);
    for (const s of serials.rows) {
      await client.query(`select setval(pg_get_serial_sequence($1, $2), coalesce((select max(${ident(s.c)}) from public.${ident(s.t)}), 0) + 1, false)`, [`public.${ident(s.t)}`, s.c]);
    }
    await client.query("commit");
    return { rows: counts, createdAt: header.createdAt };
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Backups in storage, oldest first (their names are timestamps). */
export async function listBackups(storage: Storage): Promise<StoredObject[]> {
  return (await storage.list(BACKUP_PREFIX)).filter((o) => o.key.endsWith(".ebobak"));
}

/** Dumps, seals and stores a backup, then keeps only the newest `keep` (14 by default). */
export async function createBackup(pool: Pool, storage: Storage, opts: { env?: Env; keep?: number; now?: Date } = {}) {
  const dump = await dumpDatabase(pool, opts.now);
  const sealed = sealBackup(dump.body, opts.env);
  const key = `${BACKUP_PREFIX}/${dump.createdAt.replace(/[:.]/g, "-")}.ebobak`;
  await storage.put(key, sealed, "application/octet-stream");
  const all = await listBackups(storage);
  const old = all.slice(0, Math.max(0, all.length - Math.max(1, opts.keep ?? 14)));
  for (const o of old) await storage.delete(o.key);
  return { key, bytes: sealed.length, rows: dump.rows, migrations: dump.migrations, removed: old.map((o) => o.key) };
}

/** Opens a stored backup ("latest", or its name) and loads it into the database behind `pool`. */
export async function restoreBackup(pool: Pool, storage: Storage, which: string, env?: Env) {
  const all = await listBackups(storage);
  const chosen = which === "latest" ? all.at(-1) : all.find((o) => o.key === which || o.key === `${BACKUP_PREFIX}/${which}`);
  if (!chosen) throw new Error(which === "latest" ? "There are no backups yet." : `There's no backup called ${which}.`);
  const restored = await restoreDatabase(pool, openBackup(await storage.get(chosen.key), env));
  return { key: chosen.key, ...restored };
}
