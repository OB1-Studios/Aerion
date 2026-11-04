"use server";

import { FIELDS, normalizeExtraction } from "@ebo/ai";
import { addDays, dateInZone, weekday } from "@ebo/core";
import { document, draftAction, flag, getDb, receivingAccount, storageFromEnv, task, workspace, type DocumentKind } from "@ebo/db";
import { resetDemoWorkspace } from "@ebo/db/seed";
import { addUpload, advanceDemoClock, approveAndSend, audit, rejectDraft as reject, sampleCreditAdvice, UPLOAD_MAX_FILES, validateCredit } from "@ebo/engine";
import { and, asc, eq, inArray, ne } from "drizzle-orm";
import { revalidatePath } from "next/cache";
import { notFound, redirect } from "next/navigation";
import { engineDeps, startRun } from "@/lib/engine";
import { humanProblem, REVIEW_KINDS, type ReviewState } from "@/lib/review";
import { actor } from "@/lib/actor";


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

// ---------------------------------------------------------------------------
// Documents: uploads and the review queue
// ---------------------------------------------------------------------------

/** Uploaded files wait as "pending"; unless asked not to, a run starts straight away to read them. */
export async function uploadDocuments(slug: string, form: FormData) {
  const { user, ws } = await actor(slug);
  const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
  if (!files.length) redirect(`/w/${slug}/documents?upload=none`);
  if (files.length > UPLOAD_MAX_FILES) redirect(`/w/${slug}/documents?upload=toomany`);
  const hint = String(form.get("kind") ?? "");
  const deps = engineDeps();
  const results = [];
  for (const f of files) {
    results.push(await addUpload(deps, ws, { name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) }, { kindHint: (hint || null) as DocumentKind | null, userId: user.id }));
  }
  const back = new URLSearchParams();
  const added = results.filter((r) => r.status === "added").length;
  const dup = results.filter((r) => r.status === "duplicate").length;
  const rejected = results.flatMap((r) => (r.status === "rejected" ? [`${r.name} ${r.reason}`] : []));
  back.set("added", String(added));
  if (dup) back.set("dup", String(dup));
  if (rejected.length) back.set("rejected", rejected.slice(0, 3).join(" · ").slice(0, 400));
  if (added && form.get("read") === "on") back.set("run", await startRun(ws.id, "manual", user.id));
  refresh(slug);
  redirect(`/w/${slug}/documents?${back}`);
}

/** Demo help: a SIMULATED credit advice paying the oldest open invoice, uploaded and read at once. */
export async function uploadSample(slug: string) {
  const { user, ws } = await actor(slug);
  const deps = engineDeps();
  const sample = await sampleCreditAdvice(deps.db, ws.id);
  if (!sample) redirect(`/w/${slug}/documents?upload=nothing-open`);
  const r = await addUpload(deps, ws, { name: sample.name, bytes: sample.bytes }, { userId: user.id });
  const back = new URLSearchParams({ sample: sample.invoiceNumber });
  if (r.status === "added") back.set("run", await startRun(ws.id, "manual", user.id));
  else back.set("dup", "1");
  refresh(slug);
  redirect(`/w/${slug}/documents?${back}`);
}

/**
 * Review queue: a person checks a document's fields. The same checks as the run happen here
 * first, so a mistake shows straight away; the run then applies the values like any reading.
 */
export async function confirmDocument(slug: string, docId: string, kind: DocumentKind, _prev: ReviewState, form: FormData): Promise<ReviewState> {
  const { user, ws } = await actor(slug);
  const db = getDb();
  const [doc] = await db.select().from(document).where(and(eq(document.workspaceId, ws.id), eq(document.id, docId)));
  if (!doc) notFound();
  const spec = FIELDS[kind];
  if (!spec || !REVIEW_KINDS.includes(kind)) return { problems: ["This kind of document can't be confirmed by hand."], values: null };
  const values = Object.fromEntries(Object.keys(spec).map((k) => [k, String(form.get(`f_${k}`) ?? "").trim()]));
  const { extraction, problems } = normalizeExtraction(kind, spec, { fields: values, evidence: {} });
  if (kind !== "eprc") {
    const accounts = await db.select().from(receivingAccount).where(eq(receivingAccount.workspaceId, ws.id));
    const ibans = accounts.flatMap((a) => (a.iban ? [a.iban] : []));
    problems.push(...validateCredit(extraction, { workspaceName: ws.name, legalName: ws.legalName, ibans, receivedOn: dateInZone(doc.receivedAt, ws.timezone) }, "yes"));
  }
  if (problems.length) return { problems: problems.map(humanProblem), values };

  const before = ((doc.extracted ?? {}) as { fields?: Record<string, string | null> }).fields ?? {};
  const changed = Object.keys(extraction.fields).filter((k) => (before[k] ?? null) !== extraction.fields[k]);
  await db
    .update(document)
    .set({
      parseStatus: "pending",
      reviewReasons: null,
      extracted: { ...(doc.extracted ?? {}), confirmed: { kind, fields: extraction.fields, by: user.id, byName: user.name, at: new Date().toISOString() } },
    })
    .where(eq(document.id, doc.id));
  await audit(db, {
    workspaceId: ws.id,
    actorType: "user",
    actorId: user.id,
    action: "document.confirmed",
    objectType: "document",
    objectId: doc.id,
    details: { kind, changed: Object.fromEntries(changed.map((k) => [k, { from: before[k] ?? null, to: extraction.fields[k] }])) },
  });
  const runId = await startRun(ws.id, "manual", user.id);
  refresh(slug);
  redirect(`/w/${slug}/documents/${doc.id}?confirmed=1&run=${runId}`);
}

/** Review queue: not ours, a duplicate, or nothing to do. Kept, but no longer waiting on anyone. */
export async function setAsideDocument(slug: string, docId: string, form: FormData) {
  const { user, ws } = await actor(slug);
  const db = getDb();
  const reason = String(form.get("reason") ?? "").trim().slice(0, 300) || "nothing to do";
  const [doc] = await db.select({ id: document.id }).from(document).where(and(eq(document.workspaceId, ws.id), eq(document.id, docId)));
  if (!doc) notFound();
  await db.update(document).set({ parseStatus: "skipped", reviewReasons: [`Set aside by ${user.name}: ${reason}`] }).where(eq(document.id, doc.id));
  await audit(db, { workspaceId: ws.id, actorType: "user", actorId: user.id, action: "document.set_aside", objectType: "document", objectId: doc.id, details: { reason } });
  refresh(slug);
  redirect(`/w/${slug}/documents/${doc.id}`);
}
