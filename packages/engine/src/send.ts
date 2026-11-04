import { checkNumbers, dateInZone, TEMPLATE_ALLOW_LIST } from "@ebo/core";
import { complianceItem, draftAction, flag, invoiceReminder, message, workspace, type Db } from "@ebo/db";
import { and, eq, inArray } from "drizzle-orm";
import { audit, workspaceClock, type Mailer } from "./context";

export interface Actor {
  type: "user" | "agent";
  id: string | null;
}

/**
 * Sends one draft. Shared by the run's send step and by a person approving a draft.
 * The numbers check runs again on the exact text being sent, whatever happened before.
 */
export async function sendDraft(deps: { db: Db; mailer: Mailer }, draftId: string, actor: Actor): Promise<{ ok: boolean; reason?: string }> {
  const { db, mailer } = deps;
  const [d] = await db.select().from(draftAction).where(eq(draftAction.id, draftId));
  if (!d) return { ok: false, reason: "Draft not found." };
  if (d.kind === "internal_task") return { ok: false, reason: "Tasks are not sent." };
  if (!["approved", "scheduled", "failed"].includes(d.status)) return { ok: false, reason: `Draft is ${d.status}.` };
  if (!d.toAddress || !d.subject || !d.bodyRendered) return { ok: false, reason: "Draft has no recipient, subject or body." };
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, d.workspaceId));
  if (!ws) return { ok: false, reason: "Workspace not found." };

  const check = checkNumbers(`${d.subject}\n${d.bodyRendered}`, d.evidence ?? {}, TEMPLATE_ALLOW_LIST);
  if (!check.ok) {
    await db.update(draftAction).set({ status: "blocked", numbersCheck: check }).where(eq(draftAction.id, d.id));
    await audit(db, { workspaceId: d.workspaceId, actorType: actor.type, actorId: actor.id, action: "draft.blocked", objectType: "draft_action", objectId: d.id, details: { failures: check.failures } });
    return { ok: false, reason: "A number in the draft doesn't match the records." };
  }

  const at = workspaceClock(ws);
  const from = ws.settings?.mailboxAddress ?? `no-reply@${ws.emailDomain ?? "example.invalid"}`;
  await db.update(draftAction).set({ status: "sending" }).where(eq(draftAction.id, d.id));
  let providerId: string | null = null;
  try {
    providerId = (await mailer.send({ workspaceId: ws.id, from, to: d.toAddress, cc: d.ccAddress, subject: d.subject, body: d.bodyRendered })).messageId;
  } catch (err) {
    await db.update(draftAction).set({ status: "failed", rejectedReason: String(err) }).where(eq(draftAction.id, d.id));
    return { ok: false, reason: `Sending failed: ${String(err)}` };
  }

  const today = dateInZone(at, ws.timezone);
  await db.transaction(async (tx) => {
    const [m] = await tx
      .insert(message)
      .values({ workspaceId: ws.id, direction: "out", fromAddress: from, toAddress: d.toAddress!, subject: d.subject, sentAt: at, bodyText: d.bodyRendered, threadKey: d.subject?.replace(/^(re|fwd?):\s*/gi, "") ?? null, mailboxUid: providerId })
      .returning({ id: message.id });
    await tx.update(draftAction).set({ status: "sent", sentAt: at, messageId: m!.id }).where(eq(draftAction.id, d.id));

    const stage = /:stage(\d+)$/.exec(d.key)?.[1];
    if (d.invoiceId && stage && ["T1", "T2", "T3"].includes(d.template ?? "")) {
      await tx.insert(invoiceReminder).values({ workspaceId: ws.id, invoiceId: d.invoiceId, stage: Number(stage), sentOn: today, draftActionId: d.id });
    }
    if (d.flagIds.length) {
      const flags = await tx.select().from(flag).where(inArray(flag.id, d.flagIds));
      if (d.template === "T8") {
        const itemIds = flags.filter((f) => f.subjectType === "compliance_item").map((f) => f.subjectId);
        if (itemIds.length) await tx.update(complianceItem).set({ status: "requested", requestedAt: at }).where(and(inArray(complianceItem.id, itemIds), eq(complianceItem.status, "missing")));
      }
      await tx.update(flag).set({ status: "actioned", updatedAt: new Date() }).where(and(inArray(flag.id, d.flagIds), eq(flag.status, "open")));
    }
  });
  await audit(db, { workspaceId: ws.id, actorType: actor.type, actorId: actor.id, action: "email.sent", objectType: "draft_action", objectId: d.id, details: { template: d.template, to: d.toAddress, subject: d.subject, mailer: mailer.kind } });
  return { ok: true };
}

/** A person approves a draft; in this build approval sends it straight away. */
export async function approveAndSend(deps: { db: Db; mailer: Mailer }, draftId: string, userId: string): Promise<{ ok: boolean; reason?: string }> {
  const { db } = deps;
  const [d] = await db.select().from(draftAction).where(eq(draftAction.id, draftId));
  if (!d) return { ok: false, reason: "Draft not found." };
  if (d.status !== "draft" && d.status !== "scheduled") return { ok: false, reason: `Draft is ${d.status}.` };
  const [ws] = await db.select().from(workspace).where(eq(workspace.id, d.workspaceId));
  await db.update(draftAction).set({ status: "approved", approvedBy: userId, approvedAt: ws ? workspaceClock(ws) : new Date() }).where(eq(draftAction.id, d.id));
  await audit(db, { workspaceId: d.workspaceId, actorType: "user", actorId: userId, action: "draft.approved", objectType: "draft_action", objectId: d.id, details: { template: d.template, subject: d.subject } });
  return sendDraft(deps, draftId, { type: "user", id: userId });
}

export async function rejectDraft(db: Db, draftId: string, userId: string, reason: string): Promise<void> {
  const [d] = await db.select().from(draftAction).where(eq(draftAction.id, draftId));
  if (!d || !["draft", "blocked", "scheduled"].includes(d.status)) return;
  await db.update(draftAction).set({ status: "rejected", rejectedReason: reason || "Rejected" }).where(eq(draftAction.id, d.id));
  await audit(db, { workspaceId: d.workspaceId, actorType: "user", actorId: userId, action: "draft.rejected", objectType: "draft_action", objectId: d.id, details: { reason } });
}
