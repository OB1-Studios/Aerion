import { backupStorageFromEnv, createPool, getPool, loadLocalEnv, workspace } from "@ebo/db";
import { runMigrations } from "@ebo/db/migrate";
import { resetSharedDemo } from "@ebo/db/seed";
import { advanceDemoClock, createBackup, listBackups, restoreBackup, runWorkspace } from "@ebo/engine";
import { eq } from "drizzle-orm";
import { depsFromEnv } from "./deps";

/**
 * pnpm --filter @ebo/worker cli <command>
 *   run <slug>         run the workflow now, in this process
 *   next-week <slug>   move a demo workspace's clock on 7 days, then run
 *   reset-demo         reload the shared demo workspaces (needs DEMO_PASSWORD)
 *   backup             back up the database to Object Storage now (as the nightly job does)
 *   backups            list the stored backups
 *   restore <name|latest> <database url>
 *                      restore a backup into a new, empty database (migrated first if it's blank)
 */
const [cmd, slug, target] = process.argv.slice(2);
loadLocalEnv();
const deps = depsFromEnv();

async function bySlug(s: string | undefined) {
  if (!s) throw new Error("give a workspace slug");
  const [ws] = await deps.db.select().from(workspace).where(eq(workspace.slug, s));
  if (!ws) throw new Error(`no workspace ${s}`);
  return ws;
}

async function main() {
  if (cmd === "run" || cmd === "next-week") {
    const ws = await bySlug(slug);
    if (cmd === "next-week") console.log(`clock -> ${(await advanceDemoClock(deps.db, ws.id)).toISOString()}`);
    const r = await runWorkspace(deps, ws.id, { kind: "manual" });
    console.log(`${r.status}${r.error ? `: ${r.error}` : ""}\n${r.summary}`);
  } else if (cmd === "reset-demo") {
    if (!process.env.DEMO_PASSWORD) throw new Error("set DEMO_PASSWORD");
    console.log(await resetSharedDemo(deps.db, deps.storage, process.env.DEMO_PASSWORD));
  } else if (cmd === "backup") {
    const storage = backupStorageFromEnv();
    const b = await createBackup(getPool(), storage, { keep: Number(process.env.BACKUP_KEEP) || 14 });
    console.log(`${b.key} (${storage.kind}): ${Object.values(b.rows).reduce((a, n) => a + n, 0)} rows in ${Object.keys(b.rows).length} tables, ${b.bytes} bytes sealed`);
    if (b.removed.length) console.log(`removed older: ${b.removed.join(", ")}`);
  } else if (cmd === "backups") {
    const list = await listBackups(backupStorageFromEnv());
    for (const b of list) console.log(`${b.key}  ${(b.size / 1024).toFixed(1)} KB  ${b.modified.toISOString()}`);
    if (!list.length) console.log("no backups yet");
  } else if (cmd === "restore") {
    if (!slug || !target) throw new Error("usage: restore <name|latest> <database url>");
    const where = (u: string) => `${new URL(u).host}${new URL(u).pathname}`;
    if (process.env.DATABASE_URL && where(target) === where(process.env.DATABASE_URL)) throw new Error("That's the app's own database. Restore into a new one, then point DATABASE_URL at it.");
    const pool = createPool(target, 2);
    try {
      const { rows } = await pool.query<{ t: string | null }>(`select to_regclass('drizzle.__drizzle_migrations')::text as t`);
      if (!rows[0]?.t) {
        console.log("blank database: applying migrations first");
        await runMigrations(target);
      }
      const r = await restoreBackup(pool, backupStorageFromEnv(), slug);
      console.log(`restored ${r.key} (taken ${r.createdAt}): ${Object.values(r.rows).reduce((a, n) => a + n, 0)} rows in ${Object.keys(r.rows).length} tables`);
    } finally {
      await pool.end();
    }
  } else {
    console.log("commands: run <slug> | next-week <slug> | reset-demo | backup | backups | restore <name|latest> <database url>");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
