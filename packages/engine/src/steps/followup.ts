import { addDays } from "@ebo/core";
import { clientClaim, document, promiseToPay, task, transaction } from "@ebo/db";
import { and, eq, inArray } from "drizzle-orm";
import type { Step } from "./types";

/**
 * Follow-up: what the next run will look for, and what needs a person now.
 * (Flags whose condition cleared were already closed by the flag step.)
 */
export const followUpStep: Step = {
  name: "follow_up",
  async run(c) {
    const { db } = c.deps;
    const wsId = c.w.ws.id;
    const [claims, promises, review, unmatched, tasks] = await Promise.all([
      db.select().from(clientClaim).where(and(eq(clientClaim.workspaceId, wsId), eq(clientClaim.status, "open"))),
      db.select().from(promiseToPay).where(and(eq(promiseToPay.workspaceId, wsId), eq(promiseToPay.status, "open"))),
      db.select({ id: document.id, name: document.originalName, reasons: document.reviewReasons }).from(document).where(and(eq(document.workspaceId, wsId), eq(document.parseStatus, "needs_review"))),
      db.select({ id: transaction.id }).from(transaction).where(and(eq(transaction.workspaceId, wsId), inArray(transaction.matchStatus, ["unmatched", "duplicate"]))),
      db.select({ id: task.id }).from(task).where(and(eq(task.workspaceId, wsId), eq(task.status, "open"))),
    ]);
    const nextRun = addDays(c.w.today, ((8 - new Date(`${c.w.today}T00:00:00Z`).getUTCDay()) % 7) || 7); // next Monday
    c.counts.needs_person = (c.counts.awaiting_approval ?? 0) + review.length + unmatched.length + tasks.length;
    const parts = [
      c.counts.awaiting_approval ? `${c.counts.awaiting_approval} email${c.counts.awaiting_approval === 1 ? "" : "s"} to approve` : null,
      tasks.length ? `${tasks.length} task${tasks.length === 1 ? "" : "s"}` : null,
      review.length ? `${review.length} document${review.length === 1 ? "" : "s"} to check` : null,
      unmatched.length ? `${unmatched.length} payment${unmatched.length === 1 ? "" : "s"} to match by hand` : null,
    ].filter(Boolean);
    c.report.push(parts.length ? `Needs a person: ${parts.join(", ")}.` : "Nothing needs a person.");
    return {
      watching: { openClaims: claims.length, openPromises: promises.map((p) => ({ invoiceId: p.invoiceId, promisedOn: p.promisedOn })) },
      needsPerson: { approvals: c.counts.awaiting_approval ?? 0, tasks: tasks.length, documents: review, payments: unmatched.length },
      nextWeeklyRun: nextRun,
    };
  },
};
