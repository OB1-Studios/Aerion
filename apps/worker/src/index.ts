import { createServer } from "node:http";
import { backupStorageFromEnv, getPool, loadLocalEnv, run, sslFor, workspace } from "@ebo/db";
import { purgeExpiredDemos } from "@ebo/db/seed";
import { createBackup, queueRun, queueRunsForNewMail, runWorkspace } from "@ebo/engine";
import { eq } from "drizzle-orm";
import { PgBoss } from "pg-boss";
import { depsFromEnv } from "./deps";

/**
 * The worker: runs the workflow for queued runs (the web app queues them), the weekly
 * Monday 09:00 run for every live workspace (pg-boss cron, Pakistan time), a run whenever a
 * connected mailbox has new mail (checked every 15 minutes), the nightly encrypted database
 * backup to Object Storage, and the daily clean-up of expired visitor demos.
 */
loadLocalEnv();
const deps = depsFromEnv();
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set");
const clean = new URL(url);
clean.searchParams.delete("sslmode");
const boss = new PgBoss({ connectionString: clean.toString(), ssl: sslFor(url), schema: "pgboss", max: 4 });
boss.on("error", (err) => console.error("[pg-boss]", err));

let stopping = false;
let lastTick = Date.now();
let busy = false;

/** Takes the oldest queued run, if any. SKIP LOCKED lets several workers share the queue. */
async function claimRun(): Promise<{ id: string; workspace_id: string; kind: "weekly" | "on_arrival" | "manual"; triggered_by: string | null } | null> {
  const r = await getPool().query(
    `update run set status = 'running', started_at = now()
     where id = (select id from run where status = 'queued' order by started_at limit 1 for update skip locked)
     returning id, workspace_id, kind, triggered_by`,
  );
  return r.rows[0] ?? null;
}

async function loop() {
  while (!stopping) {
    lastTick = Date.now();
    try {
      const job = await claimRun();
      if (job) {
        busy = true;
        const t0 = Date.now();
        const result = await runWorkspace(deps, job.workspace_id, { runId: job.id, kind: job.kind, triggeredBy: job.triggered_by }).catch(async (err) => {
          await deps.db.update(run).set({ status: "failed", finishedAt: new Date(), error: String(err) }).where(eq(run.id, job.id));
          return { status: "failed", error: String(err) };
        });
        console.log(`[run] ${job.id} ${result.status} in ${Date.now() - t0} ms${"error" in result && result.error ? `: ${result.error}` : ""}`);
        busy = false;
        continue;
      }
    } catch (err) {
      busy = false;
      console.error("[run loop]", err);
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function main() {
  await boss.start();
  for (const q of ["weekly-runs", "purge-demos", "mailbox-check", "backup"]) await boss.createQueue(q);
  await boss.schedule("weekly-runs", "0 9 * * 1", null, { tz: "Asia/Karachi" });
  await boss.schedule("purge-demos", "30 3 * * *", null, { tz: "Asia/Karachi" });
  await boss.schedule("mailbox-check", "*/15 * * * *", null, { tz: "Asia/Karachi" });
  await boss.schedule("backup", "30 2 * * *", null, { tz: "Asia/Karachi" });
  await boss.work("weekly-runs", async () => {
    const live = await deps.db.select({ id: workspace.id }).from(workspace).where(eq(workspace.isDemo, false));
    for (const w of live) await queueRun(deps, w.id, { kind: "weekly" });
    console.log(`[cron] queued weekly runs for ${live.length} workspace(s)`);
  });
  await boss.work("mailbox-check", async () => {
    const r = await queueRunsForNewMail(deps);
    if (r.checked) console.log(`[cron] checked ${r.checked} mailbox(es): ${r.queued} run(s) queued, ${r.errors} error(s)`);
  });
  await boss.work("backup", async () => {
    const storage = backupStorageFromEnv();
    const b = await createBackup(getPool(), storage, { keep: Number(process.env.BACKUP_KEEP) || 14 });
    const rows = Object.values(b.rows).reduce((a, n) => a + n, 0);
    console.log(`[cron] backup ${b.key} to ${storage.kind}: ${rows} rows, ${b.bytes} bytes${b.removed.length ? `; removed ${b.removed.length} older` : ""}`);
  });
  await boss.work("purge-demos", async () => {
    const n = await purgeExpiredDemos(deps.db, deps.storage);
    console.log(`[cron] purged ${n} expired demo workspace(s)`);
  });

  const port = Number(process.env.WORKER_PORT ?? 8081);
  createServer((req, res) => {
    const healthy = Date.now() - lastTick < (busy ? 15 * 60_000 : 30_000);
    res.writeHead(healthy ? 200 : 503, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: healthy, busy, lastTick: new Date(lastTick).toISOString() }));
  }).listen(port, () => console.log(`[worker] health on :${port}, storage ${deps.storage.kind}, readers ${deps.readers.document.name}`));

  await loop();
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    stopping = true;
    await boss.stop({ graceful: true, timeout: 10_000 }).catch(() => undefined);
    process.exit(0);
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
