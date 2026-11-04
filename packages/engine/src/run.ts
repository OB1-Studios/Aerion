import { run, runStep, workspace, type Db } from "@ebo/db";
import { and, eq, gt } from "drizzle-orm";
import { audit, demoMailer, loadContext, type EngineDeps } from "./context";
import { offlineIntentReader } from "./readers/intent";
import { offlineDocumentReader } from "./readers/offline";
import { draftStep } from "./steps/draft";
import { flagStep } from "./steps/flag";
import { followUpStep } from "./steps/followup";
import { planStep } from "./steps/plan";
import { pullStep } from "./steps/pull";
import { readStep } from "./steps/read";
import { reconcileStep } from "./steps/reconcile";
import { sendStep } from "./steps/send";
import type { Step, StepContext } from "./steps/types";

/** The weekly workflow, in order (main doc section 6): plan -> pull -> read -> reconcile -> flag -> draft -> send -> follow-up. */
export const STEPS: Step[] = [planStep, pullStep, readStep, reconcileStep, flagStep, draftStep, sendStep, followUpStep];

export const offlineReaders = { document: offlineDocumentReader, intent: offlineIntentReader };

export function defaultDeps(base: Pick<EngineDeps, "db" | "storage"> & Partial<EngineDeps>): EngineDeps {
  return { readers: offlineReaders, mailer: demoMailer, ...base };
}

export interface RunOptions {
  kind: "weekly" | "on_arrival" | "manual";
  triggeredBy?: string | null;
  /** A run row created earlier (status "queued"), e.g. by the web app before handing over to the worker. */
  runId?: string;
}

export interface RunResult {
  runId: string;
  status: "succeeded" | "failed";
  counts: Record<string, number>;
  summary: string;
  error?: string;
}

/** Creates a queued run row so a caller can show progress before the worker picks it up. */
export async function queueRun(deps: Pick<EngineDeps, "db">, workspaceId: string, opts: Omit<RunOptions, "runId">): Promise<string> {
  const [ws] = await deps.db.select().from(workspace).where(eq(workspace.id, workspaceId));
  if (!ws) throw new Error("workspace not found");
  const [r] = await deps.db
    .insert(run)
    .values({ workspaceId, kind: opts.kind, clockAt: ws.demoClock ?? new Date(), status: "queued", triggeredBy: opts.triggeredBy ?? null })
    .returning({ id: run.id });
  return r!.id;
}

/**
 * Takes one queued run for this process. Exactly one caller wins when the worker and the web
 * process (RUNS_INLINE=1) both try: the row lock makes the losing update find it no longer queued.
 */
export async function claimQueuedRun(db: Db, runId: string): Promise<boolean> {
  const rows = await db
    .update(run)
    .set({ status: "running", startedAt: new Date() })
    .where(and(eq(run.id, runId), eq(run.status, "queued")))
    .returning({ id: run.id });
  return rows.length > 0;
}

/** Runs the whole workflow for one workspace and records every step. One run per workspace at a time. */
export async function runWorkspace(deps: EngineDeps, workspaceId: string, opts: RunOptions): Promise<RunResult> {
  const { db } = deps;
  const w = await loadContext(db, workspaceId, deps.env);
  const busy = await db
    .select({ id: run.id })
    .from(run)
    .where(and(eq(run.workspaceId, workspaceId), eq(run.status, "running"), gt(run.startedAt, new Date(Date.now() - 15 * 60_000))));
  const other = busy.find((r) => r.id !== opts.runId);
  if (other) throw new Error(`a run is already in progress for this workspace (${other.id})`);

  let runId = opts.runId;
  if (runId) {
    await db.update(run).set({ status: "running", startedAt: new Date(), clockAt: w.clock }).where(eq(run.id, runId));
  } else {
    const [r] = await db.insert(run).values({ workspaceId, kind: opts.kind, clockAt: w.clock, status: "running", triggeredBy: opts.triggeredBy ?? null }).returning({ id: run.id });
    runId = r!.id;
  }
  await audit(db, { workspaceId, actorType: opts.triggeredBy ? "user" : "agent", actorId: opts.triggeredBy ?? runId, action: "run.started", objectType: "run", objectId: runId, details: { kind: opts.kind, clock: w.clock.toISOString() } });

  const counts: Record<string, number> = {};
  const report: string[] = [];
  let failure: string | undefined;
  for (const [position, step] of STEPS.entries()) {
    const [s] = await db.insert(runStep).values({ runId, workspaceId, position, step: step.name, status: "running" }).returning({ id: runStep.id });
    const c: StepContext = { deps, w, runId, stepId: s!.id, counts, report };
    try {
      const output = await step.run(c);
      await db.update(runStep).set({ status: "succeeded", finishedAt: new Date(), output }).where(eq(runStep.id, s!.id));
    } catch (err) {
      failure = err instanceof Error ? `${err.message}` : String(err);
      await db.update(runStep).set({ status: "failed", finishedAt: new Date(), error: failure }).where(eq(runStep.id, s!.id));
      for (const later of STEPS.slice(position + 1)) {
        await db.insert(runStep).values({ runId, workspaceId, position: STEPS.indexOf(later), step: later.name, status: "skipped", finishedAt: new Date() });
      }
      break;
    }
  }
  const status = failure ? "failed" : "succeeded";
  const summary = failure ? [...report, `Stopped: ${failure}`].join("\n") : report.join("\n");
  await db.update(run).set({ status, finishedAt: new Date(), counts, summary, error: failure ?? null }).where(eq(run.id, runId));
  await audit(db, { workspaceId, actorType: "agent", actorId: runId, action: `run.${status}`, objectType: "run", objectId: runId, details: { counts } });
  return { runId, status, counts, summary, error: failure };
}
