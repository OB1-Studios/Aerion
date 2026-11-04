"use server";

import { addDays, dateInZone, weekday } from "@ebo/core";
import { draftAction, flag, getDb, storageFromEnv, task, workspace } from "@ebo/db";
import { resetDemoWorkspace } from "@ebo/db/seed";
import { advanceDemoClock, approveAndSend, audit, rejectDraft as reject } from "@ebo/engine";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { engineDeps, startRun } from "@/lib/engine";
import { canAct, requireWorkspace } from "@/lib/session";

/** The signed-in member, if their role may change things here (owners for settings). */
async function actor(slug: string, need: "act" | "own" = "act") {
  const m = await requireWorkspace(slug);
  if (need === "own" ? m.role !== "owner" : !canAct(m.role)) throw new Error(need === "own" ? "Only the workspace owner can change this." : "Your role can view this workspace but not change it.");
  return m;
}

const refresh = (slug: string) => revalidatePath(`/w/${slug}`, "layout");

async function draftIn(workspaceId: string, id: string) {
  const [d] = await getDb()
    .select()
    .from(draftAction)
    .where(and(eq(draftAction.workspaceId, workspaceId), eq(draftAction.id, id)));
  return d ?? null;
}

async function nextDraft(workspaceId: string, after: string) {
  const [d] = await getDb()
    .select({ id: draftAction.id })
    .from(draftAction)
    .where(and(eq(draftAction.workspaceId, workspaceId), inArray(draftAction.status, ["draft", "scheduled"]), ne(draftAction.id, after)))
    .orderBy(asc(draftAction.createdAt), asc(draftAction.subject))
    .limit(1);
  return d?.id ?? null;
}

// ---------------------------------------------------------------------------
// Runs and the demo clock
// ---------------------------------------------------------------------------

export async function runNow(slug: string) {
  const { user, ws } = await actor(slug);
  const runId = await startRun(ws.id, "manual", user.id);
  refresh(slug);
  redirect(`/w/${slug}/runs/${runId}`);
}

/** Demo: move the simulated clock to next Monday 09:00 (PKT) and do the weekly run then. */
export async function nextWeek(slug: string) {
  const { user, ws } = await actor(slug);
  if (!ws.isDemo || !ws.demoClock) throw new Error("Only demo workspaces have a simulated clock.");
  const today = dateInZone(ws.demoClock, ws.timezone);
  const monday = addDays(today, (8 - weekday(today)) % 7 || 7);
  // Pakistan has no daylight saving: 09:00 PKT is always 04:00 UTC.
  const target = new Date(`${monday}T09:00:00+05:00`);
  await advanceDemoClock(getDb(), ws.id, (target.getTime() - ws.demoClock.getTime()) / 86_400_000, user.id);
  const runId = await startRun(ws.id, "weekly", user.id);
  refresh(slug);
  redirect(`/w/${slug}/runs/${runId}`);
}

/** Demo: an hour later (lets delayed autopilot emails reach their send time), then run. */
export async function nextHour(slug: string) {
  const { user, ws } = await actor(slug);
  await advanceDemoClock(getDb(), ws.id, 1 / 24, user.id);
  const runId = await startRun(ws.id, "manual", user.id);
  refresh(slug);
  redirect(`/w/${slug}/runs/${runId}`);
}

export async function resetDemo(slug: string) {
  const { ws } = await actor(slug);
  if (!ws.isDemo) throw new Error("Only demo workspaces can be reset.");
  await resetDemoWorkspace(getDb(), storageFromEnv(), ws.id);
  refresh(slug);
  redirect(`/w/${slug}/inbox?reset=1`);
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

export async function approveDraft(slug: string, draftId: string) {
  const { user, ws } = await actor(slug);
  const d = await draftIn(ws.id, draftId);
  if (!d) notFound();
  const r = await approveAndSend(engineDeps(), d.id, user.id);
  refresh(slug);
  if (!r.ok) redirect(`/w/${slug}/drafts/${d.id}?error=${encodeURIComponent(r.reason ?? "Not sent.")}`);
  const next = await nextDraft(ws.id, d.id);
  redirect(next ? `/w/${slug}/drafts/${next}?sent=${d.id}` : `/w/${slug}/inbox?sent=${d.id}`);
}

/** Approves every draft waiting for a person, one by one; each is still checked number by number. */
export async function approveAll(slug: string) {
  const { user, ws } = await actor(slug);
  const waiting = await getDb()
    .select({ id: draftAction.id })
    .from(draftAction)
    .where(and(eq(draftAction.workspaceId, ws.id), eq(draftAction.status, "draft")))
    .orderBy(asc(draftAction.createdAt));
  let sent = 0;
  for (const d of waiting) if ((await approveAndSend(engineDeps(), d.id, user.id)).ok) sent++;
  refresh(slug);
  redirect(`/w/${slug}/inbox?sentAll=${sent}`);
}

export async function rejectDraft(slug: string, draftId: string, form: FormData) {
  const { user, ws } = await actor(slug);
  const d = await draftIn(ws.id, draftId);
  if (!d) notFound();
  const reason = String(form.get("reason") ?? "").trim() || (d.status === "scheduled" ? "Cancelled before sending" : "Rejected");
  await reject(getDb(), d.id, user.id, reason);
  refresh(slug);
  redirect(`/w/${slug}/inbox`);
}

// ---------------------------------------------------------------------------
// Tasks and flags
// ---------------------------------------------------------------------------

export async function completeTask(slug: string, taskId: string, form: FormData) {
  const { user, ws } = await actor(slug);
  const note = String(form.get("note") ?? "").trim() || null;
  const done = await getDb()
    .update(task)
    .set({ status: "done", doneNote: note })
    .where(and(eq(task.workspaceId, ws.id), eq(task.id, taskId), eq(task.status, "open")))
    .returning({ id: task.id, title: task.title });
  if (done[0]) await audit(getDb(), { workspaceId: ws.id, actorType: "user", actorId: user.id, action: "task.done", objectType: "task", objectId: done[0].id, details: { title: done[0].title, note } });
  refresh(slug);
}

export async function dismissFlag(slug: string, flagId: string, form: FormData) {
  const { user, ws } = await actor(slug);
  const reason = String(form.get("reason") ?? "").trim();
  if (!reason) throw new Error("Say why the flag doesn't need action.");
  const db = getDb();
  const [f] = await db
    .update(flag)
    .set({ status: "dismissed", dismissedBy: user.id, dismissedReason: reason, updatedAt: new Date() })
    .where(and(eq(flag.workspaceId, ws.id), eq(flag.id, flagId), inArray(flag.status, ["open", "actioned"])))
    .returning();
  if (f) {
    // Drafts that were only about this flag aren't needed any more.
    const drafts = await db.select().from(draftAction).where(and(eq(draftAction.workspaceId, ws.id), inArray(draftAction.status, ["draft", "blocked", "scheduled"])));
    const only = drafts.filter((d) => d.flagIds.length === 1 && d.flagIds[0] === f.id).map((d) => d.id);
    if (only.length) await db.update(draftAction).set({ status: "cancelled", rejectedReason: "The flag was dismissed." }).where(inArray(draftAction.id, only));
    await audit(db, { workspaceId: ws.id, actorType: "user", actorId: user.id, action: "flag.dismissed", objectType: "flag", objectId: f.key, details: { kind: f.kind, reason, draftsCancelled: only.length } });
  }
  refresh(slug);
  redirect(`/w/${slug}/flags/${flagId}`);
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function setPolicy(slug: string, form: FormData) {
  const { user, ws } = await actor(slug, "own");
  const mode = form.get("mode") === "autopilot" ? "autopilot" : "supervised";
  if (mode === ws.approvalPolicy.mode) return;
  await getDb()
    .update(workspace)
    .set({ approvalPolicy: { ...ws.approvalPolicy, mode } })
    .where(eq(workspace.id, ws.id));
  await audit(getDb(), { workspaceId: ws.id, actorType: "user", actorId: user.id, action: "policy.changed", objectType: "workspace", objectId: ws.id, details: { from: ws.approvalPolicy.mode, to: mode } });
  refresh(slug);
}

/** Owner switch: read this workspace's documents with Vultr Serverless Inference, or with the offline rules only. */
export async function setAiReading(slug: string, form: FormData) {
  const { user, ws } = await actor(slug, "own");
  const enabled = form.get("enabled") === "on";
  if (enabled === ws.aiReadingEnabled) return;
  await getDb().update(workspace).set({ aiReadingEnabled: enabled }).where(eq(workspace.id, ws.id));
  await audit(getDb(), { workspaceId: ws.id, actorType: "user", actorId: user.id, action: "ai_reading.changed", objectType: "workspace", objectId: ws.id, details: { enabled } });
  refresh(slug);
}
