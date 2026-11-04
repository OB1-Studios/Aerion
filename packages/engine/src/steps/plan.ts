import { formatDateLong, retainerDue } from "@ebo/core";
import { contract, demoInboxItem, document, draftAction, flag, invoice, transaction } from "@ebo/db";
import { and, count, eq, inArray, isNull, lte } from "drizzle-orm";
import { retainerTerms } from "../retainers";
import type { Step } from "./types";

/**
 * Plan: look at what is waiting before doing anything, and say what this run will do.
 * Deterministic; the timeline shows it so a person can see why each step ran.
 */
export const planStep: Step = {
  name: "plan",
  async run(c) {
    const { db } = c.deps;
    const wsId = c.w.ws.id;
    const n = async (q: Promise<Array<{ n: number }>>) => Number((await q)[0]?.n ?? 0);
    const [arrived, pendingDocs, pendingTx, openInvoices, openFlags, approved, contracts] = await Promise.all([
      n(db.select({ n: count() }).from(demoInboxItem).where(and(eq(demoInboxItem.workspaceId, wsId), isNull(demoInboxItem.pulledAt), lte(demoInboxItem.deliverAt, c.w.clock)))),
      n(db.select({ n: count() }).from(document).where(and(eq(document.workspaceId, wsId), eq(document.parseStatus, "pending")))),
      n(db.select({ n: count() }).from(transaction).where(and(eq(transaction.workspaceId, wsId), inArray(transaction.matchStatus, ["pending", "unmatched"])))),
      n(db.select({ n: count() }).from(invoice).where(and(eq(invoice.workspaceId, wsId), inArray(invoice.status, ["sent", "part_paid"])))),
      n(db.select({ n: count() }).from(flag).where(and(eq(flag.workspaceId, wsId), inArray(flag.status, ["open", "actioned"])))),
      n(db.select({ n: count() }).from(draftAction).where(and(eq(draftAction.workspaceId, wsId), inArray(draftAction.status, ["approved", "scheduled"])))),
      db.select().from(contract).where(and(eq(contract.workspaceId, wsId), eq(contract.kind, "retainer"))),
    ]);
    const retainers = contracts.filter((r) => retainerDue(retainerTerms(r), c.w.today)).length;
    const steps = [
      { step: "pull", why: arrived ? `${arrived} item${arrived === 1 ? "" : "s"} arrived in the mailbox or upload folder` : "check the mailbox" },
      { step: "read", why: `classify and extract ${arrived + pendingDocs} new document${arrived + pendingDocs === 1 ? "" : "s"} and emails` },
      { step: "reconcile", why: `match new money (${pendingTx} unreconciled now) against ${openInvoices} open invoice${openInvoices === 1 ? "" : "s"}` },
      { step: "flag", why: `re-check every rule; ${openFlags} flag${openFlags === 1 ? " is" : "s are"} open` },
      { step: "draft", why: `${retainers ? `draft ${retainers} retainer invoice${retainers === 1 ? "" : "s"} due this month, then ` : ""}write emails and tasks for open flags, checked number by number` },
      { step: "send", why: approved ? `${approved} approved or scheduled email${approved === 1 ? "" : "s"} to send` : `send per the ${c.w.ws.approvalPolicy.mode} policy` },
      { step: "follow_up", why: "close claims and promises, list what needs a person" },
    ];
    c.report.push(`Run for ${formatDateLong(c.w.today)} (${c.w.ws.isDemo ? "simulated clock" : "live"}), approval policy: ${c.w.ws.approvalPolicy.mode}.`);
    return { clock: c.w.clock.toISOString(), today: c.w.today, policy: c.w.ws.approvalPolicy, waiting: { arrived, pendingDocs, pendingTx, openInvoices, openFlags, approved, retainers }, steps };
  },
};
