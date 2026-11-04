import "server-only";
import { getDb, run, storageFromEnv } from "@ebo/db";
import { readersFromEnv } from "@ebo/ai";
import { claimQueuedRun, defaultDeps, offlineReaders, queueRun, runWorkspace, type EngineDeps } from "@ebo/engine";
import { eq } from "drizzle-orm";
import { after } from "next/server";

let deps: EngineDeps | null = null;

/** Engine dependencies for the web process (approvals send through the same code as runs). */
export function engineDeps(): EngineDeps {
  if (!deps) {
    const model = readersFromEnv();
    deps = defaultDeps({ db: getDb(), storage: storageFromEnv(), readers: model ? { document: model.document, intent: model.intent } : offlineReaders });
  }
  return deps;
}

/**
 * RUNS_INLINE=1 runs the workflow inside the web process (local development, or a single
 * container). It's safe alongside a worker: whichever claims the queued run first runs it.
 */
export const runsInline = () => process.env.RUNS_INLINE === "1";

/**
 * Queues a run and returns its id straight away, so the page can show the timeline filling in.
 * The worker claims queued runs within a couple of seconds; with RUNS_INLINE=1 the web
 * process runs it itself once the response has gone out.
 */
export async function startRun(workspaceId: string, kind: "weekly" | "manual", userId: string): Promise<string> {
  const d = engineDeps();
  const runId = await queueRun(d, workspaceId, { kind, triggeredBy: userId });
  if (runsInline()) {
    after(async () => {
      try {
        if (!(await claimQueuedRun(d.db, runId))) return; // the worker took it
        await runWorkspace(d, workspaceId, { kind, triggeredBy: userId, runId });
      } catch (err) {
        await d.db.update(run).set({ status: "failed", finishedAt: new Date(), error: err instanceof Error ? err.message : String(err) }).where(eq(run.id, runId));
      }
    });
  }
  return runId;
}
