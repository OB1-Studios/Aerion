import { draftAction } from "@ebo/db";
import { and, eq, inArray } from "drizzle-orm";
import { sendDraft } from "../send";
import { bump, type Step } from "./types";

/**
 * Send: emails a person approved, emails the policy lets go out on its own ("auto"),
 * and delayed ones whose wait is over. Under the supervised policy nothing goes out
 * without an approval.
 */
export const sendStep: Step = {
  name: "send",
  async run(c) {
    const { db } = c.deps;
    const wsId = c.w.ws.id;
    const due = (await db.select().from(draftAction).where(and(eq(draftAction.workspaceId, wsId), inArray(draftAction.status, ["approved", "scheduled"])))).filter(
      (d) => d.status === "approved" || (d.scheduledFor && d.scheduledFor <= c.w.clock),
    );
    const sent: string[] = [];
    const failed: Array<{ subject: string | null; reason?: string }> = [];
    for (const d of due) {
      const r = await sendDraft({ db, mailer: c.deps.mailer }, d.id, { type: "agent", id: c.runId });
      if (r.ok) sent.push(d.subject ?? d.key);
      else failed.push({ subject: d.subject, reason: r.reason });
    }
    const waiting = (await db.select({ id: draftAction.id }).from(draftAction).where(and(eq(draftAction.workspaceId, wsId), eq(draftAction.status, "draft")))).length;
    const scheduled = (await db.select({ id: draftAction.id }).from(draftAction).where(and(eq(draftAction.workspaceId, wsId), eq(draftAction.status, "scheduled")))).length;
    bump(c, "sent", sent.length);
    c.counts.awaiting_approval = waiting;
    if (sent.length) c.report.push(`Sent ${sent.length} email${sent.length === 1 ? "" : "s"} (${c.deps.mailer.kind === "demo" ? "recorded, not delivered: demo mailbox" : "delivered"}).`);
    if (scheduled) c.report.push(`${scheduled} email${scheduled === 1 ? "" : "s"} will go out after the cancel window.`);
    if (waiting) c.report.push(`${waiting} email${waiting === 1 ? "" : "s"} wait${waiting === 1 ? "s" : ""} for approval.`);
    return { sent, failed, awaitingApproval: waiting, scheduled, mailer: c.deps.mailer.kind };
  },
};
