import { businessDaysBetween, checkNumbers, dateInZone, formatDateLong, formatMoney, periodLabel, planDrafts, TEMPLATE_ALLOW_LIST, type FlagCandidate, type RuleKey } from "@ebo/core";
import { draftAction, flag, task } from "@ebo/db";
import { and, eq, inArray } from "drizzle-orm";
import { audit } from "../context";
import { draftContext, loadBooks } from "../books";
import { draftDueRetainers } from "../retainers";
import { EDITED_BY_PERSON } from "../send";
import { bump, type Step } from "./types";

/** A bank gets this many business days to answer a document request before a person chases it. */
const CHASE_AFTER_BUSINESS_DAYS = 5;

export function flagRowToCandidate(f: typeof flag.$inferSelect): FlagCandidate {
  return { key: f.key, kind: f.kind, severity: f.severity, subject: { type: f.subjectType as FlagCandidate["subject"]["type"], id: f.subjectId }, summary: f.summary, evidence: f.evidence, ruleKeys: f.ruleKeys as RuleKey[] };
}

/**
 * Draft: write this month's retainer invoices that are due (retainers.ts), then turn open flags
 * into emails and tasks (core/drafting.ts), filled from templates and checked number by number.
 * Re-runs update a draft nobody has acted on instead of adding another; drafts whose flags have
 * closed are cancelled.
 */
export const draftStep: Step = {
  name: "draft",
  async run(c) {
    const { db } = c.deps;
    const wsId = c.w.ws.id;

    const retainers = await draftDueRetainers(db, c.w, c.runId);
    for (const r of retainers) {
      const what = `the ${periodLabel(r.period)} retainer invoice for ${r.client}`;
      if (!r.number) c.report.push(`Couldn't draft ${what}: ${r.problem} A task asks a person to fix it.`);
      else {
        bump(c, "retainer_invoices");
        c.report.push(`Drafted ${what} (${r.number}, ${formatMoney(r.amount, r.currency, { grouping: c.w.ws.numberGrouping })})${r.draftId ? "; the email that sends it waits for approval" : `, but not its email: ${r.problem}`}.`);
      }
    }
    const books = await loadBooks(db, c.w);
    const flags = await db.select().from(flag).where(and(eq(flag.workspaceId, wsId), inArray(flag.status, ["open", "actioned"])));
    const items = new Map(books.compliance.map((x) => [x.id, x]));

    // Documents already requested from the bank: no second email; chase by phone after a while.
    const forDrafting: FlagCandidate[] = [];
    const chase: Array<{ f: typeof flag.$inferSelect; since: string }> = [];
    for (const f of flags) {
      const item = f.subjectType === "compliance_item" ? items.get(f.subjectId) : undefined;
      if ((f.kind === "missing_eprc" || f.kind === "missing_wht_certificate") && item?.status === "requested") {
        const since = item.requestedAt ? dateInZone(item.requestedAt, c.w.ws.timezone) : c.w.today;
        if (businessDaysBetween(since, c.w.today) >= CHASE_AFTER_BUSINESS_DAYS) chase.push({ f, since });
        continue;
      }
      forDrafting.push(flagRowToCandidate(f));
    }

    const ctx = draftContext(books, c.w);
    const plans = planDrafts(forDrafting, ctx);
    const flagId = new Map(flags.map((f) => [f.key, f.id]));
    const drafts = new Map((await db.select().from(draftAction).where(eq(draftAction.workspaceId, wsId))).map((d) => [d.key, d]));
    const tasks = new Map((await db.select().from(task).where(eq(task.workspaceId, wsId))).flatMap((t) => (t.key ? [[t.key, t] as const] : [])));
    const created: Array<Record<string, unknown>> = [];
    const refreshed: string[] = [];
    const newTasks: string[] = [];

    for (const p of plans) {
      const ids = p.flagKeys.flatMap((k) => (flagId.has(k) ? [flagId.get(k)!] : []));
      if (p.kind === "internal_task") {
        const existing = tasks.get(p.key);
        if (!existing) {
          await db.insert(task).values({ workspaceId: wsId, key: p.key, title: p.subject, detail: p.body, ownerId: p.ownerUserId ?? null, dueOn: p.dueOn ?? null, flagId: ids[0] ?? null, createdAt: c.w.clock });
          newTasks.push(p.subject);
        } else if (existing.status === "open") {
          await db.update(task).set({ title: p.subject, detail: p.body }).where(eq(task.id, existing.id));
        }
        continue;
      }
      const mode = p.decision?.mode ?? "approve";
      const status = mode === "blocked" ? "blocked" : mode === "approve" ? "draft" : mode === "auto" ? "approved" : "scheduled";
      const content = {
        kind: p.kind,
        template: p.template ?? null,
        flagIds: ids,
        invoiceId: p.invoiceId ?? null,
        toAddress: p.to ?? null,
        subject: p.subject,
        bodyTemplate: p.bodyTemplate ?? null,
        bodyRendered: p.body,
        evidence: p.evidence,
        numbersCheck: p.numbersCheck ?? null,
        sendDecision: p.decision ?? null,
      };
      const existing = drafts.get(p.key);
      if (!existing) {
        await db.insert(draftAction).values({
          workspaceId: wsId,
          key: p.key,
          ...content,
          status,
          scheduledFor: mode === "delay" ? new Date(c.w.clock.getTime() + c.w.ws.approvalPolicy.delayMinutes * 60_000) : null,
          approvedBy: mode === "auto" ? "agent" : null,
          approvedAt: mode === "auto" ? c.w.clock : null,
          model: "template",
          runId: c.runId,
          createdAt: c.w.clock, // the workspace's clock, like the flags it answers (a demo runs on a simulated one)
        });
        created.push({ key: p.key, template: p.template, to: p.to, subject: p.subject, decision: p.decision });
        bump(c, `drafts_${status}`);
      } else if ((existing.status === "draft" || existing.status === "blocked") && existing.model === EDITED_BY_PERSON) {
        // A person rewrote this email: keep their words, bring the facts up to date, and check
        // their text against those facts. If the records moved under it, it's held, not redrafted.
        const check = checkNumbers(`${existing.subject ?? ""}\n${existing.bodyRendered ?? ""}`, p.evidence, TEMPLATE_ALLOW_LIST);
        await db
          .update(draftAction)
          .set({
            flagIds: ids,
            evidence: p.evidence,
            numbersCheck: check,
            status: check.ok ? "draft" : "blocked",
            rejectedReason: check.ok ? null : "The records changed after a person edited this email; a number in it no longer matches.",
            sendDecision: check.ok ? { mode: "approve", reasons: ["A person edited this email, so a person approves it before it goes."] } : { mode: "blocked", reasons: ["A number in the edited text no longer matches the records."] },
          })
          .where(eq(draftAction.id, existing.id));
        refreshed.push(p.key);
      } else if (existing.status === "draft" || existing.status === "blocked") {
        await db.update(draftAction).set({ ...content, status, rejectedReason: null }).where(eq(draftAction.id, existing.id)); // a draft held back after the invoice changed is redrafted here
        refreshed.push(p.key);
      }
    }

    for (const { f, since } of chase) {
      const key = `chase:${f.key}`;
      if (tasks.has(key)) continue;
      const what = f.kind === "missing_eprc" ? "ePRC" : "withholding certificate";
      const inv = f.evidence["invoice.number"]?.type === "text" ? f.evidence["invoice.number"].value : "";
      const bank = f.evidence["bank.name"]?.type === "text" ? f.evidence["bank.name"].value : "the bank";
      await db.insert(task).values({ workspaceId: wsId, key, title: `Call ${bank} about the ${what}${inv ? ` for ${inv}` : ""}`, detail: `Requested by email on ${formatDateLong(since)} and still not received. ${f.summary}`, ownerId: books.owners[0] ?? null, dueOn: c.w.today, flagId: f.id, createdAt: c.w.clock });
      newTasks.push(`Chase the ${what}${inv ? ` for ${inv}` : ""}`);
    }

    // Drafts nobody acted on whose flags have all closed are no longer needed. Invoice emails
    // (T11) come from a person, not a flag, so they stay until someone sends or rejects them.
    const live = new Set(plans.map((p) => p.key));
    const openIds = new Set(flags.map((f) => f.id));
    const stale = [...drafts.values()].filter((d) => ["draft", "blocked", "scheduled"].includes(d.status) && d.template !== "T11" && !live.has(d.key) && !d.flagIds.some((id) => openIds.has(id)));
    if (stale.length) await db.update(draftAction).set({ status: "cancelled", rejectedReason: "No longer needed: the problem was resolved." }).where(inArray(draftAction.id, stale.map((d) => d.id)));

    await audit(db, [
      ...created.map((d) => ({ workspaceId: wsId, actorType: "agent" as const, actorId: c.runId, action: "draft.created", objectType: "draft_action", objectId: d.key as string, details: d })),
      ...newTasks.map((t) => ({ workspaceId: wsId, actorType: "agent" as const, actorId: c.runId, action: "task.created", objectType: "task", objectId: null, details: { title: t } })),
    ]);
    bump(c, "tasks_created", newTasks.length);
    const waiting = created.filter((d) => (d.decision as { mode?: string } | undefined)?.mode === "approve").length;
    const blocked = created.filter((d) => (d.decision as { mode?: string } | undefined)?.mode === "blocked").length;
    if (created.length) c.report.push(`Drafted ${created.length} email${created.length === 1 ? "" : "s"}${waiting ? `, ${waiting} waiting for approval` : ""}${blocked ? `, ${blocked} blocked by the numbers check` : ""}.`);
    if (newTasks.length) c.report.push(`Created ${newTasks.length} task${newTasks.length === 1 ? "" : "s"} for a person: ${newTasks.join("; ")}.`);
    return { retainers, created, refreshed, cancelled: stale.map((d) => d.key), tasks: newTasks };
  },
};
